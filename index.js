const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('<h1>✅ Бот и База MongoDB работают!</h1>');
});
app.listen(port, '0.0.0.0', () => console.log(`✅ Webview активен на порту ${port}`));

require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, REST, Routes, 
    SlashCommandBuilder, Collection, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle 
} = require('discord.js');
const mongoose = require('mongoose');

// --- ПОДКЛЮЧЕНИЕ К БАЗЕ ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ База MongoDB подключена'))
    .catch(err => console.error('❌ Ошибка MongoDB:', err));

// Схемы данных
const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    joins: { type: Number, default: 0 },
    leaves: { type: Number, default: 0 },
    fakes: { type: Number, default: 0 }
});
const connectionSchema = new mongoose.Schema({
    invitedId: { type: String, unique: true },
    inviterId: String
});
const giveawaySchema = new mongoose.Schema({
    msgId: { type: String, unique: true },
    prize: String,
    desc: String,
    endUnix: Number,
    winners: Number,
    participants: [String],
    channelId: String,
    status: { type: String, default: 'active' }
});

const User = mongoose.model('User', userSchema);
const Connection = mongoose.model('Connection', connectionSchema);
const Giveaway = mongoose.model('Giveaway', giveawaySchema);

// --- НАСТРОЙКИ ---
const ALLOWED_GUILD_ID = '1466085204127907922'; 
const OWNER_ROLE_ID = '1466088975507915011'; 
const BOT_COLOR = 0x5865F2; 
const FAKE_LIMIT_MS = 1000 * 60 * 60 * 24 * 90; // 90 дней

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildInvites, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

const invitesCache = new Collection();

// --- ЛОГИКА ИНВАЙТОВ ---
client.once('ready', async () => {
    const commands = [
        new SlashCommandBuilder().setName('invites').setDescription('📊 Статистика приглашений').addUserOption(o => o.setName('user').setDescription('Пользователь')),
        new SlashCommandBuilder().setName('giveaway').setDescription('🎉 Создать розыгрыш'),
        new SlashCommandBuilder().setName('help').setDescription('📖 Команды бота')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, ALLOWED_GUILD_ID), { body: commands });

    console.log(`✅ Бот онлайн: ${client.user.tag}`);
    const guild = client.guilds.cache.get(ALLOWED_GUILD_ID);
    if (guild) {
        const invs = await guild.invites.fetch();
        invitesCache.set(guild.id, new Collection(invs.map(i => [i.code, i.uses])));
    }
    setInterval(checkGiveaways, 30000);
});

client.on('guildMemberAdd', async member => {
    const guild = member.guild;
    const oldInvites = invitesCache.get(guild.id);
    const newInvites = await guild.invites.fetch();
    const invite = newInvites.find(i => i.uses > (oldInvites.get(i.code) || 0));
    
    invitesCache.set(guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

    if (invite && invite.inviter) {
        const isFake = (Date.now() - member.user.createdTimestamp) < FAKE_LIMIT_MS;
        await Connection.findOneAndUpdate({ invitedId: member.id }, { inviterId: invite.inviter.id }, { upsert: true });
        
        const update = isFake ? { $inc: { joins: 1, fakes: 1 } } : { $inc: { joins: 1 } };
        await User.findOneAndUpdate({ userId: invite.inviter.id }, update, { upsert: true });
    }
});

client.on('guildMemberRemove', async member => {
    const conn = await Connection.findOne({ invitedId: member.id });
    if (conn) {
        await User.findOneAndUpdate({ userId: conn.inviterId }, { $inc: { leaves: 1 } });
    }
});

// --- ЛОГИКА РОЗЫГРЫШЕЙ ---
client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;
    const hasAccess = interaction.member.roles.cache.has(OWNER_ROLE_ID);

    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'invites') {
            const target = interaction.options.getUser('user') || interaction.user;
            const data = await User.findOne({ userId: target.id }) || { joins: 0, leaves: 0, fakes: 0 };
            const total = Math.max(0, data.joins - data.leaves - data.fakes);

            const embed = new EmbedBuilder().setColor(BOT_COLOR).setTitle(`📊 Статистика: ${target.username}`)
                .addFields(
                    { name: 'Чистых', value: `**${total}**`, inline: true },
                    { name: 'Входов', value: `${data.joins}`, inline: true },
                    { name: 'Выходов', value: `${data.leaves}`, inline: true },
                    { name: 'Фейки (90д)', value: `${data.fakes}`, inline: true }
                );
            return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'giveaway') {
            if (!hasAccess) return interaction.reply({ content: '❌ Нет прав.', ephemeral: true });
            const modal = new ModalBuilder().setCustomId('gw_modal').setTitle('Создание розыгрыша');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_prize').setLabel("Приз").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_desc').setLabel("Описание").setStyle(TextInputStyle.Paragraph).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_time').setLabel("Время (мин)").setStyle(TextInputStyle.Short).setValue('60')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_winners').setLabel("Победителей").setStyle(TextInputStyle.Short).setValue('1'))
            );
            return interaction.showModal(modal);
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'gw_modal') {
        const prize = interaction.fields.getTextInputValue('gw_prize');
        const desc = interaction.fields.getTextInputValue('gw_desc');
        const timeMin = parseInt(interaction.fields.getTextInputValue('gw_time')) || 60;
        const winners = parseInt(interaction.fields.getTextInputValue('gw_winners')) || 1;
        const endUnix = Math.floor(Date.now() / 1000) + (timeMin * 60);

        const embed = new EmbedBuilder().setColor(BOT_COLOR).setTitle(prize)
            .setDescription(`${desc}\n\n**Победителей:** ${winners}\n**Участников:** 0\n**Конец:** <t:${endUnix}:R>`);
        
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gw_join').setLabel('Участвовать').setStyle(ButtonStyle.Primary));
        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

        await new Giveaway({ msgId: msg.id, prize, desc, endUnix, winners, participants: [], channelId: interaction.channelId }).save();
    }

    if (interaction.isButton() && interaction.customId === 'gw_join') {
        await interaction.deferReply({ ephemeral: true });
        const gw = await Giveaway.findOne({ msgId: interaction.message.id });
        if (!gw || gw.status !== 'active') return interaction.editReply('❌ Розыгрыш окончен.');
        if (gw.participants.includes(interaction.user.id)) return interaction.editReply('❌ Вы уже участвуете.');

        gw.participants.push(interaction.user.id);
        await gw.save();

        const newEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setDescription(`${gw.desc}\n\n**Победителей:** ${gw.winners}\n**Участников:** ${gw.participants.length}\n**Конец:** <t:${gw.endUnix}:R>`);
        await interaction.message.edit({ embeds: [newEmbed] });
        return interaction.editReply('✅ Вы вступили!');
    }
});

async function checkGiveaways() {
    const now = Math.floor(Date.now() / 1000);
    const active = await Giveaway.find({ status: 'active', endUnix: { $lte: now } });
    for (const gw of active) {
        const channel = await client.channels.fetch(gw.channelId).catch(() => null);
        if (!channel) continue;
        const msg = await channel.messages.fetch(gw.msgId).catch(() => null);
        const winnersArr = gw.participants.sort(() => 0.5 - Math.random()).slice(0, gw.winners);
        
        const resEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle(`🎉 Розыгрыш окончен: ${gw.prize}`)
            .setDescription(`**Победители:**\n${winnersArr.length ? winnersArr.map(id => `<@${id}>`).join('\n') : "Нет участников"}`);
        
        if (msg) await msg.edit({ embeds: [resEmbed], components: [] });
        gw.status = 'ended';
        await gw.save();
        if (winnersArr.length) channel.send(`🎉 Поздравляем <@${winnersArr.join('>, <@')}> с победой в **${gw.prize}**!`);
    }
}

client.login(process.env.DISCORD_TOKEN);
