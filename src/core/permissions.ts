export type Role = "admin" | "user" | "readonly";

export interface RoleConfig {
  allowed_tools: string[];
  max_turns: number;
  max_budget_usd: number;
}

const PRESETS: Record<Role, RoleConfig> = {
  admin: {
    allowed_tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebSearch", "WebFetch", "Task"],
    max_turns: 100,
    max_budget_usd: 10.0,
  },
  user: {
    allowed_tools: ["Read", "Edit", "Bash", "Grep", "Glob", "WebSearch", "WebFetch"],
    max_turns: 50,
    max_budget_usd: 2.0,
  },
  readonly: {
    allowed_tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    max_turns: 20,
    max_budget_usd: 0.5,
  },
};

export interface UserRoleEntry {
  id: string;       // user id (telegram number or discord snowflake)
  role: Role;
}

export class PermissionManager {
  private userRoles = new Map<string, Role>();
  private defaultRole: Role;
  private customRoles: Record<string, RoleConfig>;

  constructor(
    users: UserRoleEntry[],
    defaultRole: Role = "user",
    customRoles: Record<string, RoleConfig> = {}
  ) {
    this.defaultRole = defaultRole;
    this.customRoles = customRoles;
    for (const u of users) this.userRoles.set(u.id, u.role);
  }

  getRole(userId: string): Role {
    return this.userRoles.get(userId) || this.defaultRole;
  }

  getRoleConfig(userId: string): RoleConfig {
    const role = this.getRole(userId);
    return this.customRoles[role] || PRESETS[role];
  }
}
