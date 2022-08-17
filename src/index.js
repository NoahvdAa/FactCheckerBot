require('@tensorflow/tfjs-node');
const use = require('@tensorflow-models/universal-sentence-encoder');

const config = require('../config.json');
const { facts, responses } = require('../data.json');

const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');
const Keyv = require('keyv');
const { Routes } = require('discord-api-types/v9');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');

const client = new Client({
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES]
});
const kv = new Keyv();

let model;
let dataVector = [];
let dataToFact = [];

let matchId = Date.now(); // Prevent collision after restart

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    let confidence;
    let fact = facts.find((fact) => fact.triggers.find((trigger) => message.content.toLowerCase().indexOf(trigger.toLowerCase()) !== -1));
    if (fact) {
        confidence = 100;
    } else {
        if (message.content.length < 10) return; // not worth the CPU time

        const query = await model.embed([message.content.toLowerCase()]);
        const inputVector = await query.array();

        const userQueryVector = inputVector[0];
        const predictions = dataVector
            .map((dataEntry, dataEntryIndex) => {
                const similarity = cosineSimilarity(userQueryVector, dataEntry);
                return {
                    similarity,
                    result: dataToFact[dataEntryIndex]
                };
                // sort descending
            })
            .sort((a, b) => b.similarity - a.similarity);

        const bestPrediction = predictions[0];
        confidence = bestPrediction.similarity * 100;
        if (!bestPrediction || confidence < config.minimumConfidence) return;

        fact = facts.find(f => f.id === bestPrediction.result);
    }
    if (!fact) return;

    matchId++;

    const cooldownKey = `${message.channel.id}-${fact.id}`;
    if (await kv.get(cooldownKey)) {
        const reaction = await message.react('⏳');
        setTimeout(async () => await reaction.users.remove(client.user), 10000);
        log(`${message.author.tag} (${message.author.id}) triggered cooling down fact ${fact.id} (${fact.exact ? 'exact, ' : ''}match id ${matchId}, confidence ${confidence.toFixed(2)}%) with message: ${message.content}`);
        return;
    }

    const embed = new MessageEmbed()
        .setColor(0xDD7838)
        .setTitle(fact.name)
        .setDescription(fact.body)
        .setTimestamp(new Date())
        .setFooter({
            text: `Triggered by ${message.author.tag} | ${confidence.toFixed(2)}% confidence`,
            iconURL: message.member.displayAvatarURL()
        });

    let row = new MessageActionRow();
    if (!fact.exact) {
        const cmKey = `cm-${matchId}`;
        const fpKey = `fp-${matchId}`;
        row.addComponents(new MessageButton()
            .setCustomId(cmKey)
            .setLabel('Correct match')
            .setStyle('PRIMARY')
        ).addComponents(new MessageButton()
            .setCustomId(fpKey)
            .setLabel('False positive')
            .setStyle('SECONDARY'));
    }

    await kv.set(matchId, { users: [], points: 0, fact: fact.id, trigger: message.content }, 60 * 60 * 1000);

    const response = responses[Math.floor(Math.random() * responses.length)]
        .replaceAll('@user', `<@${message.author.id}>`);

    await message.reply({
        content: response,
        embeds: [embed],
        components: fact.exact ? undefined : [row]
    });

    await kv.set(cooldownKey, true, fact.cooldown);

    log(`${message.author.tag} (${message.author.id}) triggered fact ${fact.id} (${fact.exact ? 'exact, ' : ''}match id ${matchId}, confidence ${confidence.toFixed(2)}%) with message: ${message.content}`);
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) return await handleAutoCompletionInteraction(interaction);
    if (interaction.isButton()) return await handleButtonInteraction(interaction);
    if (interaction.isCommand()) return await handleCommandInteraction(interaction);
});

async function handleButtonInteraction(interaction) {
    const parts = interaction.customId.split('-');
    const action = parts[0];
    const id = parts[1];
    const match = await kv.get(id);
    if (match === undefined) return;

    if (match.users.indexOf(interaction.user.id) !== -1) {
        await interaction.reply({ content: 'You already flagged this message!', ephemeral: true });
        return;
    }

    let points = 1;
    for (const role of interaction.member._roles) {
        const roleWeight = config.roleWeight[role];
        if (roleWeight <= 0 && roleWeight < points) points = roleWeight;
        else if (points > 0 && roleWeight > points) points = roleWeight;
    }
    if (action === 'fp') {
        match.points -= points;
    } else {
        match.points += points;
    }
    match.users.push(interaction.user.id);

    await interaction.reply({
        content: action === 'fp' ? 'This message has been marked as a false positive. It will be deleted if it gets enough flags. Thank you for helping us improve the bot.' : 'This message has been marked as a successful match. Thank you for helping us improve the bot.',
        ephemeral: true
    });
    if (action === 'fp') {
        log(`${interaction.user.tag} (${interaction.user.id}) marked match ${id} as a false positive with ${points} points, message is at ${match.points}/${config.requiredPointsForFPDelete}`);
    } else {
        log(`${interaction.user.tag} (${interaction.user.id}) marked match ${id} as a correct match with ${points} points, message is at ${match.points}/${config.requiredPointsForCM}`);
    }
    if (match.points > -config.requiredPointsForFPDelete && match.points < config.requiredPointsForCM) {
        await kv.set(id, match, 60 * 60 * 1000);
        return;
    }

    if (action === 'fp') {
        await interaction.message.delete();
        await interaction.editReply({
            content: 'This message has been deleted because it was flagged as a false positive. Thank you for helping us improve the bot.',
            ephemeral: true
        });
        await kv.delete(id);
        log(`Match ${id} has been deleted due to a false positive`);
    } else {
        await interaction.message.edit({ components: [] });
        await kv.delete(id);
        log(`Match ${id} has been verified as a correct match`);
    }
}

async function handleCommandInteraction(interaction) {
    const factName = interaction.options.getString('id');

    const fact = facts.find(f => f.id === factName);
    if (!fact) {
        interaction.reply({ content: 'That fact doesn\'t exist!', ephemeral: true });
        return;
    }

    const embed = new MessageEmbed()
        .setColor(0xFEE75C)
        .setTitle(fact.name)
        .setDescription(fact.body)
        .setTimestamp(new Date());
    interaction.reply({ embeds: [embed] })
}

async function handleAutoCompletionInteraction(interaction) {
    const focusedValue = interaction.options.getFocused();
    const filtered = facts.filter(fact => fact.id.startsWith(focusedValue));
    await interaction.respond(filtered.map(choice => ({ name: choice.id, value: choice.id })),);
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    if (process.argv.length >= 3 && process.argv[2].toLowerCase() === 'register') {
        console.log('Registering commands...');
        const command = new SlashCommandBuilder()
            .setName('fact')
            .setDescription('Requests a specific factoid')
            .addStringOption(option => option.setName('id').setDescription('The fact\'s id').setAutocomplete(true).setRequired(true));

        const rest = new REST({ version: '9' }).setToken(config.token);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [command.toJSON()] },
        );
        console.log('Registered commands!');
    }
});

async function log(message) {
    console.log(message);

    const channel = await client.channels.fetch(config.logChannel);
    await channel.send(message);
}

use.load().then(async (modl) => {
    model = modl;
    let f = [];
    for (const fact of facts) {
        for (const trigger of fact.triggers) {
            f.push(trigger.toLowerCase());
            dataToFact.push(fact.id);
            if (trigger.toLowerCase().indexOf('mojang') !== -1) {
                f.push(trigger.toLowerCase().replace(/mojang/gi, 'microsoft'));
                dataToFact.push(fact.id);
            }
        }
    }
    const data = await model.embed(f);
    dataVector = await data.array();

    console.log('Logging in...');
    await client.login(config.token);
});

// multiple with value with corresponding value in the other array at the same index, then sum.
const dotProduct = (vector1, vector2) => {
    return vector1.reduce((product, current, index) => {
        product += current * vector2[index];
        return product;
    }, 0);
};

// sqaure each value in the array and add them all up, then square root.
const vectorMagnitude = (vector) => {
    return Math.sqrt(
        vector.reduce((sum, current) => {
            sum += current * current;
            return sum;
        }, 0)
    );
};

const cosineSimilarity = (vector1, vector2) => {
    return (
        dotProduct(vector1, vector2) /
        (vectorMagnitude(vector1) * vectorMagnitude(vector2))
    );
};
