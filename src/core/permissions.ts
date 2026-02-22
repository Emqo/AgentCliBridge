/** Simple whitelist: allowed users + groups. Empty = allow all. */
export class AccessControl {
  private users: Set<string>;
  private groups: Set<string>;

  constructor(users: string[] = [], groups: string[] = []) {
    this.users = new Set(users.map(String));
    this.groups = new Set(groups.map(String));
  }

  isAllowed(userId: string, groupId?: string): boolean {
    if (!this.users.size && !this.groups.size) return true;
    if (this.users.has(String(userId))) return true;
    if (groupId && this.groups.has(String(groupId))) return true;
    return false;
  }

  reload(users: string[], groups: string[]) {
    this.users = new Set(users.map(String));
    this.groups = new Set(groups.map(String));
  }
}
