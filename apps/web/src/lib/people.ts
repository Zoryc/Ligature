/**
 * Names of people as the server reports them. When an account is deleted (docs/ACCOUNT-DELETION.md) its
 * text, versions and trash stay in the projects, and the server sends "a former member" in place of its
 * name. Places where a name is always expected (version authors, the creator of a named version) also show
 * a blank name that way. Not the trash: there '' means the deleter was never recorded (see trash.ts).
 */

export const FORMER_MEMBER = 'a former member'

/** The display name, or "a former member" when the account no longer exists. */
export function personName(name: string | null | undefined): string {
  return name?.trim() ? name : FORMER_MEMBER
}
