# SAGAA-15 end-to-end proof

Isolated instance: `paperclipai test-drive` on 127.0.0.1:3101. The live
companies on 127.0.0.1:3100 were never touched.

Every call below was made by the plugin's own `handleInteraction`, imported
from `dist/commands.js` on branch `feat/delivery-approvals`. Bearer values are
redacted. Each delivery is a scratch issue with one approval stage held by
`local-board` and the CEO agent as the return assignee.

## 1. Accept

**Issue before**

```json
{
  "status": "in_review",
  "assigneeUserId": "local-board",
  "assigneeAgentId": null,
  "lastDecisionOutcome": null,
  "executionStateStatus": "pending"
}
```

**Calls the plugin made**

```json
[
  {
    "method": "GET",
    "url": "http://127.0.0.1:3101/api/issues/4f0b0039-95a9-4156-b096-9eca930e1e68",
    "body": null,
    "status": 200
  },
  {
    "method": "PATCH",
    "url": "http://127.0.0.1:3101/api/issues/4f0b0039-95a9-4156-b096-9eca930e1e68",
    "body": "{\"status\":\"done\",\"comment\":\"Accepted by Hanna from Discord.\"}",
    "status": 200
  }
]
```

**Interaction response**

```json
{
  "type": 7,
  "data": {
    "embeds": [
      {
        "title": "Delivery Accepted",
        "description": "Accepted by Hanna",
        "color": 5763719,
        "footer": {
          "text": "Paperclip"
        },
        "timestamp": "2026-09-26T15:10:24.444Z"
      }
    ],
    "components": []
  }
}
```

**Issue after**

```json
{
  "status": "done",
  "assigneeUserId": "local-board",
  "assigneeAgentId": null,
  "lastDecisionOutcome": "approved",
  "executionStateStatus": "completed"
}
```


## 2. Accept pressed a second time

**Calls the plugin made**

```json
[
  {
    "method": "GET",
    "url": "http://127.0.0.1:3101/api/issues/4f0b0039-95a9-4156-b096-9eca930e1e68",
    "body": null,
    "status": 200
  }
]
```

**Interaction response**

```json
{
  "type": 7,
  "data": {
    "embeds": [
      {
        "title": "Already Settled",
        "description": "This delivery is no longer waiting on you, so nothing changed.",
        "color": 16705372,
        "footer": {
          "text": "Paperclip"
        },
        "timestamp": "2026-09-26T15:10:24.461Z"
      }
    ],
    "components": []
  }
}
```

**Issue after**

```json
{
  "status": "done",
  "assigneeUserId": "local-board",
  "assigneeAgentId": null,
  "lastDecisionOutcome": "approved",
  "executionStateStatus": "completed"
}
```


## 3. Request changes

**Issue before**

```json
{
  "status": "in_review",
  "assigneeUserId": "local-board",
  "assigneeAgentId": null,
  "lastDecisionOutcome": null,
  "executionStateStatus": "pending"
}
```

**Calls the plugin made on the button press**

```json
[]
```

**Button response (the modal)**

```json
{
  "type": 9,
  "data": {
    "custom_id": "delivery_changes_modal_f43f0d6d-b80c-4ee0-83ac-656cc7550d8d",
    "title": "Request changes",
    "components": [
      {
        "type": 1,
        "components": [
          {
            "type": 4,
            "custom_id": "reason",
            "label": "What needs to change?",
            "style": 2,
            "required": true,
            "max_length": 1900
          }
        ]
      }
    ]
  }
}
```

**Calls the plugin made on the modal submit**

```json
[
  {
    "method": "GET",
    "url": "http://127.0.0.1:3101/api/issues/f43f0d6d-b80c-4ee0-83ac-656cc7550d8d",
    "body": null,
    "status": 200
  },
  {
    "method": "PATCH",
    "url": "http://127.0.0.1:3101/api/issues/f43f0d6d-b80c-4ee0-83ac-656cc7550d8d",
    "body": "{\"status\":\"in_progress\",\"comment\":\"The gate output is missing. Attach it and resubmit.\"}",
    "status": 200
  }
]
```

**Modal submit response**

```json
{
  "type": 7,
  "data": {
    "embeds": [
      {
        "title": "Changes Requested",
        "description": "Changes requested by Hanna\n\n> The gate output is missing. Attach it and resubmit.",
        "color": 16705372,
        "footer": {
          "text": "Paperclip"
        },
        "timestamp": "2026-09-26T15:10:24.550Z"
      }
    ],
    "components": []
  }
}
```

**Issue after**

```json
{
  "status": "in_progress",
  "assigneeUserId": null,
  "assigneeAgentId": "6a6105c2-3703-4c74-92e7-0a91d2633198",
  "lastDecisionOutcome": "changes_requested",
  "executionStateStatus": "changes_requested"
}
```


## 4. A crafted custom_id makes no call

**Calls the plugin made**

```json
[]
```

**Interaction response**

```json
{
  "type": 4,
  "data": {
    "content": "This button no longer names an issue Paperclip can decide. Decide it in Paperclip.",
    "flags": 64
  }
}
```


## Plugin log lines

```
INFO  Delivery accept button clicked {"issueId":"4f0b0039-95a9-4156-b096-9eca930e1e68"}
INFO  Delivery accept button clicked {"issueId":"4f0b0039-95a9-4156-b096-9eca930e1e68"}
INFO  delivery decision: the issue is no longer waiting on the board {"issueId":"4f0b0039-95a9-4156-b096-9eca930e1e68","outcome":"approved"}
INFO  Delivery request-changes button clicked {"issueId":"f43f0d6d-b80c-4ee0-83ac-656cc7550d8d"}
WARN  delivery decision: the interaction carried no usable issue id {"source":"delivery_accept_../../companies"}
```