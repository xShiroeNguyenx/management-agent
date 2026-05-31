# Agent Manager — Plan

Extension VSCode độc lập, tách ra từ tính năng **Agent Accounts** của `anime-companion-vscode`.
Mục tiêu: lưu và đổi nhanh giữa nhiều tài khoản agent (Claude, Codex, Antigravity) bằng cách
snapshot/restore credential, cộng với chọn tài khoản GitHub extension này dùng.

## Quyết định thiết kế
- **Branding:** `name: management-agent`, `displayName: "Agent Manager"`, command prefix `agentMgr.*`.
- Backend Claude/Codex = file-swap (copy file credential trong home dir).
- **GitHub/Copilot:** copy y bản gốc nhưng đây là extension độc lập không gọi Copilot →
  việc đổi tài khoản chỉ set preference cho session của chính extension này (mang tính
  hiển thị/parity, không đổi account của Copilot hay extension khác).
- Phạm vi: Status Bar item + webview panel "Agent Accounts" + 6 lệnh. Không thêm tree view.

### Antigravity — ĐÃ GỠ (2026-05-31)
Đã thử thêm backend Antigravity nhưng **gỡ bỏ** vì không khả thi cho build hiện tại của máy:
- Máy có 2 thư mục `Antigravity` (cũ, key `antigravityAuthStatus` + email plaintext) và
  `Antigravity IDE` (bản mới đang dùng). Bản mới lưu login dạng **token OAuth protobuf**
  (`antigravityUnifiedStateSync.oauthToken`…), **không có email trong DB**.
- Switch phải ghi đè state.vscdb khi Antigravity **đóng hẳn** → không thể switch từ trong
  chính IDE đang chạy extension.
- Chưa xác minh được secret nằm trong DB hay OS keychain → swap có thể làm hỏng login.
- → Người dùng chọn gỡ Antigravity, giữ Claude/Codex/GitHub. Có thể làm lại sau khi
  reverse-engineer xong build mới (chạy từ VS Code, Antigravity đóng).

## Cấu trúc

```
management-agent/
├── package.json
├── tsconfig.json
├── .eslintrc.cjs / .gitignore / .vscodeignore
├── README.md
├── .vscode/
│   ├── launch.json             # Run Extension (F5)
│   └── tasks.json              # tsc watch (default build)
└── src/
    ├── extension.ts            # activate() + AgentProfileStatusBar + 6 command + github service
    ├── log.ts
    ├── github-account-service.ts   # chọn tài khoản GitHub extension dùng
    └── agent-profiles/
        ├── types.ts
        ├── profile-store.ts        # globalState
        ├── profile-manager.ts      # save/use/delete/detect + capability wrappers + GitHub
        ├── profile-panel.ts        # webview UI (CLI + GitHub)
        ├── credential-fs.ts        # snapshot/restore/backup (file backends)
        └── backends/
            ├── account-backend.ts  # interface (file + custom) + registry
            ├── claude-backend.ts   # ~/.claude
            └── codex-backend.ts    # ~/.codex
```

## Cách hoạt động
- Mỗi **profile** là một snapshot các file credential (whitelist) của một tool, lưu trong
  `globalStorageUri/agent-profiles/<id>/snapshot/`.
- **Save**: copy file credential hiện hành của tool → snapshot.
- **Use**: backup credential đang sống (`.backup-<tool>-<timestamp>`, giữ tối đa 3) rồi restore
  snapshot của profile vào home dir của tool.
- **Detect active**: so khớp "signature" credential đang sống với từng snapshot để biết profile nào active.
- State: `globalState["agentProfiles.store"]` = `{ profiles, activeId }`.

## Lệnh
| Command | Title |
|---|---|
| `agentMgr.showPanel` | Agent Accounts: Manage… |
| `agentMgr.save` | Agent Accounts: Save Current As… |
| `agentMgr.list` | Agent Accounts: List |
| `agentMgr.use` | Agent Accounts: Quick Switch… (cũng là lệnh khi click status bar) |
| `agentMgr.delete` | Agent Accounts: Delete… |
| `agentMgr.githubAccount.switch` | Agent Accounts: Switch GitHub Account… |

## Build & chạy
- `npm install`
- `npm run compile` (tsc → `out/`)
- F5 trong VSCode để chạy Extension Host.

## ⚠️ Cảnh báo
Thao tác **Use** sẽ ghi đè credential thật trong `~/.claude` / `~/.codex`.
`MAX_BACKUPS=3` tự backup trước khi restore là lưới an toàn.
