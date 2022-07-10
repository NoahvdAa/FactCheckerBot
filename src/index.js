const config = require('../config.json');
const {facts, responses} = require('../data.json');

const {Client, Intents, MessageEmbed, MessageActionRow, MessageButton} = require('discord.js');
const Keyv = require('keyv');
const {NlpManager} = require('node-nlp');
const {Routes} = require('discord-api-types/v9');
const {SlashCommandBuilder} = require('@discordjs/builders');
const {REST} = require('@discordjs/rest');

const client = new Client({
    intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES]
});
const manager = new NlpManager({languages: ['en'], forceNER: true, nlu: {log: false}});
const kv = new Keyv();

for (const fact of facts) {
    for (const trigger of fact.triggers) {
        manager.addDocument('en', trigger, fact.id);
    }
}

let matchId = Date.now(); // Prevent collision after restart

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const match = await manager.process('en', message.content);
    const score = match.classifications.length > 0 ? match.classifications[0].score : 0;
    const fact = facts.find(f => f.id === match.intent);

    if (!fact) return;
    if (score < fact.minimumConfidence) return;
    if (fact.exact && fact.triggers.filter(t => message.content.indexOf(t) !== -1).length === 0) return;

    matchId++;
    const cooldownKey = `${message.channel.id}-${fact.id}`;
    if (await kv.get(cooldownKey)) {
        const reaction = await message.react('⏳');
        setTimeout(async () => await reaction.users.remove(client.user), 10000);
        log(`${message.author.tag} (${message.author.id}) triggered cooling down fact ${fact.id} (score ${score}, match id ${matchId}) with message: ${message.content}`);
        return;
    }

    const embed = new MessageEmbed()
        .setColor(0xFEE75C)
        .setTitle(fact.name)
        .setDescription(fact.body)
        .setTimestamp(new Date())
        .setFooter({
            text: `Triggered by ${message.author.tag} with ${((score > 1 ? 1 : score) * 100).toFixed(1)}% confidence`,
            iconURL: message.member.displayAvatarURL()
        });

    const fpKey = `fp-${matchId}`;
    const row = new MessageActionRow()
        .addComponents(
            new MessageButton()
                .setCustomId(fpKey)
                .setLabel('False positive')
                .setStyle('SECONDARY'),
        );

    const response = responses[Math.floor(Math.random() * responses.length)]
        .replaceAll('@user', `<@${message.author.id}>`);

    await kv.set(fpKey, {users: [], points: 0}, 60 * 60 * 1000);

    await message.reply({
        content: response,
        embeds: [embed],
        components: [row]
    });

    await kv.set(cooldownKey, true, fact.cooldown);

    log(`${message.author.tag} (${message.author.id}) triggered fact ${fact.id} (score ${score + (fact.exact ? ', exact' : '')}, match id ${matchId}) with message: ${message.content}`);
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) return await handleAutoCompletionInteraction(interaction);
    if (interaction.isButton()) return await handleButtonInteraction(interaction);
    if (interaction.isCommand()) return await handleCommandInteraction(interaction);
});

async function handleButtonInteraction(interaction) {
    const deletionRequest = await kv.get(interaction.customId);
    if (deletionRequest === undefined) return;

    if (deletionRequest.users.indexOf(interaction.user.id) !== -1) {
        await interaction.reply({content: 'You already marked this message as a false positive!', ephemeral: true});
        return;
    }

    let points = 1;
    for (const role of interaction.member._roles) {
        const roleWeight = config.roleWeight[role];
        if (roleWeight > points) points = roleWeight;
    }
    deletionRequest.points += points;
    deletionRequest.users.push(interaction.user.id);

    await interaction.reply({
        content: 'This message has been marked as a false positive. It will be deleted if it gets enough flags. Thank you for helping us improve the bot.',
        ephemeral: true
    });
    log(`${interaction.user.tag} (${interaction.user.id}) marked match ${interaction.customId} as a false positive with ${points} points, message is at ${deletionRequest.points}/${config.requiredPointsForFPDelete}`);
    if (deletionRequest.points < config.requiredPointsForFPDelete) {
        await kv.set(interaction.customId, deletionRequest, 60 * 60 * 1000);
        return;
    }

    await interaction.message.delete();
    await interaction.editReply({
        content: 'This message has been deleted because it was flagged as a false positive. Thank you for helping us improve the bot.',
        ephemeral: true
    });
    await kv.delete(interaction.customId);
    log(`Match ${interaction.customId} has been deleted due to a false positive`);
}

async function handleCommandInteraction(interaction) {
    const factName = interaction.options.getString('id');

    const fact = facts.find(f => f.id === factName);
    if (!fact) {
        interaction.reply({content: 'That fact doesn\'t exist!', ephemeral: true});
        return;
    }

    const embed = new MessageEmbed()
        .setColor(0xFEE75C)
        .setTitle(fact.name)
        .setDescription(fact.body)
        .setTimestamp(new Date());
    interaction.reply({embeds: [embed]})
}

async function handleAutoCompletionInteraction(interaction) {
    const focusedValue = interaction.options.getFocused();
    const filtered = facts.filter(fact => fact.id.startsWith(focusedValue));
    await interaction.respond(filtered.map(choice => ({name: choice.id, value: choice.id})),);
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    if (process.argv.length >= 3 && process.argv[2].toLowerCase() === 'register') {
        console.log('Registering commands...');
        const command = new SlashCommandBuilder()
            .setName('fact')
            .setDescription('Requests a specific factoid')
            .addStringOption(option => option.setName('id').setDescription('The fact\'s id').setAutocomplete(true).setRequired(true));

        const rest = new REST({version: '9'}).setToken(config.token);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            {body: [command.toJSON()]},
        );
        console.log('Registered commands!');
    }
});

(async () => {
    console.log('Training model...')
    await manager.train();
    console.log('Logging in...');
    client.login(config.token);
})();

async function log(message) {
    console.log(message);

    const channel = await client.channels.fetch(config.logChannel);
    channel.send(message);
}
