export type SchoolContext = { kind: 'school'; schoolId: string; slug: string; name: string; timezone: string };
export type HostContext = { kind: 'platform' } | SchoolContext;
