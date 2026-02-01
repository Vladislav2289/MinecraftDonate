const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('<h1>✅ Бот работает 24/7 (База данных MongoDB подключена)</h1>');
});
app.listen(port, '0.0.0.0', () => console.log(`✅ Webview запущен на порту ${port}`));

require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, REST, Routes, 
    SlashCommandBuilder, Collection, ActionRowBuilder, 
    ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle 
} = require('discord.js');
const mongoose = require('mongoose');

// --- НАСТРОЙКА MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Подключено к облачной базе MongoDB'))
    .catch(err => console.error('❌ Ошибка БД:', err));

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

// --- НАСТРОЙКИ DISCORD ---
const ALLOWED_GUILD_ID = '1466085204127907922'; 
const OWNER_ROLE_ID = '1466088975507915011'; 
const BOT_COLOR = 0x5865F2; 
const FAKE_LIMIT_MS = 1000 * 60 * 60 * 24 * 90;

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

async function checkGiveaways() {
    const now = Math.floor(Date.now() / 1000);
    try {
        const active = await Giveaway.find({ status: 'active', endUnix: { $lte: now } });
        for (const gw of active) {
            const channel = await client.channels.fetch(gw.channelId).catch(() => null);
            if (!channel) continue;
            const msg = await channel.messages.fetch(gw.msgId).catch(() => null);
            
            const participants = gw.participants;
            const winnersArr = participants.sort(() => 0.5 - Math.random()).slice(0, gw.winners);

            const winTxt = winnersArr.length ? winnersArr.map((id, i) => `**${i+1}.** <@${id}>`).join('\n') : "Никто не участвовал.";
            const endEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle(`🎉 Розыгрыш завершен: ${gw.prize}`)
                .setDescription(`**Описание:** ${gw.desc}\n\n**Победители:**\n${winTxt}\n\n**Всего участников:** ${participants.length}`);

            if (msg) await msg.edit({ embeds: [endEmbed], components: [] }).catch(() => {});
            gw.status = 'ended';
            await gw.save();
            if (winnersArr.length > 0) channel.send(`🎉 Поздравляем победителей **${gw.prize}**: ${winnersArr.map(id => `<@${id}>`).join(', ')}`);
        }
    } catch (err) { console.error(err); }
}

client.once('ready', async () => {
    const commands = [
        new SlashCommandBuilder().setName('invites').setDescription('📊 Статистика приглашений (Админ)').addUserOption(o => o.setName('user').setDescription('Пользователь')),
        new SlashCommandBuilder().setName('help').setDescription('📖 Список команд'),
        new SlashCommandBuilder().setName('say').setDescription('📢 Отправить сообщение от бота').addStringOption(o => o.setName('text').setDescription('Текст сообщения').setRequired(true)),
        new SlashCommandBuilder().setName('giveaway').setDescription('🎉 Создать розыгрыш')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, ALLOWED_GUILD_ID), { body: commands });

    console.log(`✅ Бот онлайн: ${client.user.tag}`);
    const guild = client.guilds.cache.get(ALLOWED_GUILD_ID);
    if (guild) {
        const invs = await guild.invites.fetch().catch(() => new Collection());
        invitesCache.set(guild.id, new Collection(invs.map(i => [i.code, i.uses])));
    }
    setInterval(checkGiveaways, 30000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;
    const hasAccess = interaction.member.roles.cache.has(OWNER_ROLE_ID);

    if (interaction.isChatInputCommand()) {
        if (!hasAccess) return interaction.reply({ content: `❌ У вас нет прав для использования этой команды.`, ephemeral: true });

        if (interaction.commandName === 'invites') {
            const target = interaction.options.getUser('user') || interaction.user;
            const data = await User.findOne({ userId: target.id }) || { joins: 0, leaves: 0, fakes: 0 };
            const total = Math.max(0, data.joins - data.leaves - data.fakes);

            const embed = new EmbedBuilder().setColor(BOT_COLOR).setTitle(`📊 Статистика: ${target.username}`)
                .addFields(
                    { name: 'Чистых', value: `**${total}**`, inline: true },
                    { name: 'Входов', value: `${data.joins}`, inline: true },
                    { name: 'Выходов', value: `${data.leaves}`, inline: true },
                    { name: 'Фейки', value: `${data.fakes}`, inline: true }
                ).setThumbnail(target.displayAvatarURL());
            return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'help') {
            const embed = new EmbedBuilder().setColor(BOT_COLOR).setTitle('📖 Админ-панель')
                .addFields(
                    { name: '`/invites`', value: 'Посмотреть статистику приглашений' },
                    { name: '`/giveaway`', value: 'Запустить новый розыгрыш' },
                    { name: '`/say`', value: 'Отправить текст от имени бота' }
                );
            return interaction.reply({ embeds: [embed] });
        }

        if (interaction.commandName === 'giveaway') {
            const modal = new ModalBuilder().setCustomId('gw_modal').setTitle('Настройка розыгрыша');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_prize').setLabel("Приз").setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_desc').setLabel("Описание").setStyle(TextInputStyle.Paragraph).setRequired(false)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_time').setLabel("Время (в минутах)").setStyle(TextInputStyle.Short).setValue('60')),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gw_winners').setLabel("Кол-во победителей").setStyle(TextInputStyle.Short).setValue('1'))
            );
            return interaction.showModal(modal);
        }

        if (interaction.commandName === 'say') {
            await interaction.channel.send(interaction.options.getString('text'));
            return interaction.reply({ content: '✅ Сообщение отправлено!', ephemeral: true });
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'gw_modal') {
        const prize = interaction.fields.getTextInputValue('gw_prize');
        const desc = interaction.fields.getTextInputValue('gw_desc') || "Описание отсутствует";
        const timeMin = parseInt(interaction.fields.getTextInputValue('gw_time')) || 60;
        const winnersCount = parseInt(interaction.fields.getTextInputValue('gw_winners')) || 1;
        const endUnix = Math.floor(Date.now() / 1000) + (timeMin * 60);

        const embed = new EmbedBuilder()
            .setColor(BOT_COLOR)
            .setTitle(`🎉 Новый розыгрыш: ${prize}`)
            .setDescription(`**Описание:** ${desc}\n\n**Победителей:** ${winnersCount}\n**Завершится:** <t:${endUnix}:R>`)
            .setFooter({ text: 'Нажмите кнопку ниже, чтобы участвовать!' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('gw_join').setLabel('Участвовать').setStyle(ButtonStyle.Primary)
        );

        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

        await new Giveaway({
            msgId: msg.id,
            prize,
            desc,
            endUnix,
            winners: winnersCount,
            participants: [],
            channelId: interaction.channelId
        }).save();
    }

    if (interaction.isButton() && interaction.customId === 'gw_join') {
        const gw = await Giveaway.findOne({ msgId: interaction.message.id });
        if (!gw || gw.status !== 'active') return interaction.reply({ content: '❌ Розыгрыш уже завершен.', ephemeral: true });
        if (gw.participants.includes(interaction.user.id)) return interaction.reply({ content: '❌ Вы уже участвуете.', ephemeral: true });

        gw.participants.push(interaction.user.id);
        await gw.save();
        return interaction.reply({ content: '✅ Вы успешно вступили в розыгрыш!', ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);
