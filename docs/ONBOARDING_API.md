# API подключения Telegram и администрирования

Все конечные точки JSON, кроме вебхука Telegram, требуют OAuth Bearer-токен.
Рабочее пространство всегда определяется по серверному сопоставлению
`(issuer, subject)`.

## Первый вход

Вызов `POST /api/onboarding/bootstrap` с областью доступа `onboarding.write`:

```json
{ "workspaceName": "Моя редакция" }
```

Операция идемпотентна для субъекта OAuth. Она создаёт пользователя (`User`),
рабочее пространство (`Workspace`), членство владельца (`Membership`) и связь
`AuthSubject`. `GET /api/me` возвращает созданный профиль.

## Подключение канала

1. Вызовите `POST /api/onboarding/challenges`.
2. Откройте возвращённую ссылку `telegramDeepLink` из учётной записи Telegram,
   которая владеет целевым каналом или администрирует его.
3. Добавьте указанного общего бота администратором канала и выдайте ему право
   `can_post_messages`.
4. Вызовите `POST /api/onboarding/challenges/{id}/verify`:

```json
{
  "telegramChatId": "@public_name_or_numeric_id",
  "name": "Название для редакции",
  "isDefault": true
}
```

Сервис вызывает `getChat` и дважды проверяет участника через `getChatMember`.
В базе сохраняются канонический числовой `chat.id`, заголовок, имя пользователя
и подтверждённые права бота. Канал может принадлежать только одному рабочему
пространству.

`GET /api/channels` возвращает все каналы текущего рабочего пространства.
Владелец или администратор может вызвать `POST /api/channels/{id}/disable`;
отключённый канал сразу исчезает из результата MCP-инструмента `list_channels`.

## Политика автономной публикации

Вызов `POST /api/automation-grants` с областью доступа `automations.manage`:

```json
{
  "channelIds": ["internal-channel-uuid"],
  "autonomousPublish": true,
  "maxPostsPerRun": 1,
  "maxPostsPerDay": 3,
  "bindCurrentSubject": true
}
```

Дополнительные операции:

- `GET /api/automation-grants`;
- `POST /api/automation-grants/{id}/bind-current-subject`;
- `POST /api/automation-grants/{id}/revoke`;
- `GET /api/audit?limit=100`.

Отзыв выполняется транзакционно и отвязывает от разрешения все субъекты OAuth.
`publicationMode=scheduled` никогда не позволяет обойти серверную политику.

## Вебхук Telegram

При развёртывании `POST /api/telegram/webhook` регистрируется через `setWebhook`
с секретным заголовком. Конечная точка принимает каждый числовой Telegram
`update_id` только один раз и обрабатывает только личные сообщения
`/start connect_<token>`. Исходные токены подтверждения не сохраняются: база
данных содержит значение HMAC-SHA-256 и время истечения.
