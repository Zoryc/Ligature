# Deleting an account

People can delete their own account; admins can delete anyone's. Deletion is **immediate and permanent**
(no grace period), confirmed by the account's password (self) or by typing the username (admin). The username
becomes free for a new account. Types: `packages/shared/src/api.ts`, "account deletion".

## What happens

| What | Self-deletion | Admin deletion |
|---|---|---|
| Live projects where the account is the **only member** | Deleted (soft delete, like `DELETE /projects/:id`: `deleted_at`, broadcast `project-deleted`, sockets closed, docs unloaded; purged later by the normal retention) | Same |
| Live projects it **owns with other members** | **Refused** (`409 owns-shared-projects`, the preview lists them): transfer ownership first (Members panel) | Ownership goes to the member with the earliest `added_at` among editors, else among viewers (promoted to owner); audited as `ownership-transfer` with `reason: 'account-deleted'` |
| Projects it is editor or viewer of | Membership removed; peers get `access-revoked` (presence drops) | Same |
| Soft-deleted projects it owned | Left as they are (purged by retention; nobody can see them) | Same |
| Sessions, live sockets | All deleted; sockets closed with `session-ended` (the web app shows the login page) | Same |
| Invites it created | Deleted (they would otherwise keep a link to the account) | Same |
| Text it wrote in shared projects, version history, trash, edit records | **Kept**: they belong to the project. Its id stays in `versions.created_by`, `version_authors`, `pending_authors`, `files.deleted_by`, `doc_updates.user_id`; every place that shows a name shows **"a former member"** | Same |
| Audit log | Entries kept (the record of what happened), but personal data is scrubbed: in entries whose actor is the account, or whose `detail.userId` is the account, drop `detail.ip`, `detail.username`, `detail.displayName`; in `login-failure` entries whose `detail.username` is its username, drop `username` and `ip`. The audit page shows "a deleted account". New entry `account.delete` (detail: `{ userId, by: 'self' \| 'admin', projectsDeleted, ownershipTransferred, projectsLeft }`, no name) | Same; the actor is the admin |
| The `users` row | Deleted; the username can be signed up again | Same |

Everything except the after-commit broadcasts and socket closes happens in **one** database transaction.

## Rules

- **Last admin:** an active admin cannot be deleted (self or by another admin) when no other active
  (not disabled) admin exists: `409 last-admin`. An admin cannot delete themselves through the admin route
  (`400`, use the Account page).
- **Confirmation:** `DELETE /api/me` with `{ password }` (`403 wrong-password`, rate-limited like login);
  `DELETE /api/admin/users/:id` with `{ confirmUsername }` equal to the account's username (`400 confirm-mismatch`).
- **Preview first:** `GET /api/me/deletion` and `GET /api/admin/users/:id/deletion` return
  `AccountDeletionPreview` and change nothing; the delete re-checks everything inside its transaction.
- Response `AccountDeletionResult`. Self: the session cookie is cleared.
- CLI: not needed (admins use the admin page).

## Interface

- **Account page:** a last section "Delete account" (Folio danger style). The button opens a dialog with the
  preview: if blocked, it lists the shared projects (links) and says to transfer ownership in Members first
  (or explains last-admin); otherwise it lists the projects that will be deleted, says how many it leaves,
  that edits in shared projects stay (shown as "a former member"), that this cannot be undone, then a password
  field and a red "Delete my account" button. On success: toast "Your account was deleted." and the login page.
- **Admin → Users:** a "Delete…" button (danger) per user except yourself; the dialog shows the preview
  (deleted projects, ownership transfers with the new owner's name, projects left), and requires typing the
  username. The users list refreshes.
- **"a former member"** wherever a name is looked up and the account is gone: history (version authors and
  "created by"), trash ("deleted by"), Settings' "Changed by …" (already), the audit page ("a deleted account",
  already), the storage report's owner.
