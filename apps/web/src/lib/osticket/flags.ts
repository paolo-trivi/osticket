/**
 * Costanti di bit/flag e di modo di osTicket, in un solo posto.
 * Un oggetto per classe PHP (stesso nome), chiavi = nomi delle costanti senza il prefisso `FLAG_`.
 * Codice puro: importabile da server e client. I valori sono verificati contro legacy/include
 * da test/unit/osticket-constants.test.ts.
 */

/** Collaborator::FLAG_* (class.collaborator.php), thread_collaborator.flags */
export const Collaborator = { ACTIVE: 0x0001, CC: 0x0002 } as const;

/** Dept::FLAG_* e Dept::ALERTS_* (class.dept.php), department.flags e department.group_membership */
export const Dept = {
  ASSIGN_MEMBERS_ONLY: 0x0001,
  DISABLE_AUTO_CLAIM: 0x0002,
  ACTIVE: 0x0004,
  ARCHIVED: 0x0008,
  ASSIGN_PRIMARY_ONLY: 0x0010,
  DISABLE_REOPEN_AUTO_ASSIGN: 0x0020,
  ALERTS_DEPT_ONLY: 0,
  ALERTS_DEPT_AND_EXTENDED: 1,
  ALERTS_DISABLED: 2,
  ALERTS_ADMIN_ONLY: 3,
} as const;

/** DynamicForm::FLAG_* (class.dynamic_forms.php), form.flags */
export const DynamicForm = { DELETABLE: 0x0001, DELETED: 0x0002 } as const;

/** DynamicFormField::FLAG_* e MASK_* (class.dynamic_forms.php), form_field.flags */
export const DynamicFormField = {
  ENABLED: 0x00001,
  /** valore salvato fuori da form_entry_values */
  EXT_STORED: 0x00002,
  CLOSE_REQUIRED: 0x00004,
  MASK_CHANGE: 0x00010,
  MASK_DELETE: 0x00020,
  MASK_EDIT: 0x00040,
  MASK_DISABLE: 0x00080,
  MASK_REQUIRE: 0x10000,
  MASK_VIEW: 0x20000,
  MASK_NAME: 0x40000,
  MASK_MASK_INTERNAL: 0x400b2,
  MASK_MASK_ALL: 0x700f2,
  CLIENT_VIEW: 0x00100,
  CLIENT_EDIT: 0x00200,
  CLIENT_REQUIRED: 0x00400,
  MASK_CLIENT_FULL: 0x00700,
  AGENT_VIEW: 0x01000,
  AGENT_EDIT: 0x02000,
  AGENT_REQUIRED: 0x04000,
  MASK_AGENT_FULL: 0x7000,
} as const;

/** DynamicList::MASK_* (class.list.php), list.masks */
export const DynamicList = { MASK_EDIT: 0x0001, MASK_ADD: 0x0002, MASK_DELETE: 0x0004, MASK_ABBREV: 0x0008 } as const;

/** DynamicListItem::* (class.list.php), list_items.status */
export const DynamicListItem = { ENABLED: 0x0001, INTERNAL: 0x0002 } as const;

/** Filter::FLAG_* (class.filter.php), filter.flags */
export const Filter = { INACTIVE_HT: 0x0001, INACTIVE_DEPT: 0x0002, DELETED_OBJECT: 0x0004 } as const;

/** Lock::MODE_* (class.lock.php), config ticket_lock */
export const Lock = { MODE_DISABLED: 0, MODE_ON_VIEW: 1, MODE_ON_ACTIVITY: 2 } as const;

/** OrganizationModel::* (class.organization.php), organization.status */
export const OrganizationModel = {
  COLLAB_ALL_MEMBERS: 0x0001,
  COLLAB_PRIMARY_CONTACT: 0x0002,
  ASSIGN_AGENT_MANAGER: 0x0004,
  SHARE_PRIMARY_CONTACT: 0x0008,
  SHARE_EVERYBODY: 0x0010,
} as const;

/** PluginInstance::FLAG_* (class.plugin.php), plugin_instance.flags */
export const PluginInstance = { ENABLED: 0x0001 } as const;

/** CustomQueue::FLAG_* (class.queue.php), queue.flags */
export const CustomQueue = {
  PUBLIC: 0x0001,
  QUEUE: 0x0002,
  DISABLED: 0x0004,
  INHERIT_CRITERIA: 0x0008,
  INHERIT_COLUMNS: 0x0010,
  INHERIT_SORTING: 0x0020,
  INHERIT_DEF_SORT: 0x0040,
  INHERIT_EXPORT: 0x0080,
  INHERIT_EVERYTHING: 0x158,
} as const;

/** QueueColumn::FLAG_* (class.queue.php), queue_columns.bits */
export const QueueColumn = { SORTABLE: 0x0001 } as const;

/** RoleModel::FLAG_* (class.role.php), role.flags */
export const RoleModel = { ENABLED: 0x0001 } as const;

/** Schedule::FLAG_* (class.schedule.php), schedule.flags */
export const Schedule = {
  /** orario lavorativo; senza il flag è un calendario di festività */
  BIZHRS: 0x0001,
} as const;

/** Sequence::FLAG_* (class.sequence.php), sequence.flags */
export const Sequence = { INTERNAL: 0x0001 } as const;

/** SLA::FLAG_* (class.sla.php), sla.flags */
export const SLA = { ACTIVE: 0x0001, ESCALATE: 0x0002, NOALERTS: 0x0004, TRANSIENT: 0x0008 } as const;

/** StaffDeptAccess::FLAG_* (class.staff.php), staff_dept_access.flags */
export const StaffDeptAccess = { ALERTS: 0x0001 } as const;

/** TaskModel::* (class.task.php), task.flags */
export const TaskModel = { ISOPEN: 0x0001, ISOVERDUE: 0x0002 } as const;

/** Team::FLAG_* (class.team.php), team.flags */
export const Team = { ENABLED: 0x0001, NOALERTS: 0x0002 } as const;

/** TeamMember::FLAG_* (class.team.php), team_member.flags */
export const TeamMember = { ALERTS: 0x0001 } as const;

/** ThreadEntry::FLAG_* (class.thread.php), thread_entry.flags */
export const ThreadEntry = {
  ORIGINAL_MESSAGE: 0x0001,
  EDITED: 0x0002,
  HIDDEN: 0x0004,
  /** nessuna sostituzione in modifica */
  GUARDED: 0x0008,
  RESENT: 0x0010,
  /** messaggio di un collaboratore */
  COLLABORATOR: 0x0020,
  BALANCED: 0x0040,
  /** nota di sistema */
  SYSTEM: 0x0080,
  REPLY_ALL: 0x0100,
  REPLY_USER: 0x0200,
  /** voce proveniente da un ticket figlio */
  CHILD: 0x0400,
} as const;

/** Ticket::FLAG_* (class.ticket.php), ticket.flags */
export const Ticket = { COMBINE_THREADS: 0x0001, SEPARATE_THREADS: 0x0002, LINKED: 0x0008, PARENT: 0x0010 } as const;

/** TicketStatus::* (class.list.php), ticket_status.mode */
export const TicketStatus = { ENABLED: 0x0001, INTERNAL: 0x0002 } as const;

/** Topic::FLAG_* (class.topic.php), help_topic.flags */
export const Topic = { CUSTOM_NUMBERS: 0x0001, ACTIVE: 0x0002, ARCHIVED: 0x0004 } as const;

/** UserModel::* (class.user.php), user.status */
export const UserModel = { PRIMARY_ORG_CONTACT: 0x0001 } as const;

/** UserAccountStatus::* (class.user.php), user_account.status */
export const UserAccountStatus = {
  CONFIRMED: 0x0001,
  LOCKED: 0x0002,
  REQUIRE_PASSWD_RESET: 0x0004,
  FORBID_PASSWD_RESET: 0x0008,
} as const;
