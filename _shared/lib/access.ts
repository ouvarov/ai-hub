/** Check if a user has access to a tool based on allowedGroups.
 *  No allowedGroups or empty array = public (everyone can access). */
export function hasAccess(
  allowedGroups: string[] | undefined,
  userGroups: string[],
): boolean {
  if (!allowedGroups || allowedGroups.length === 0) return true;
  return allowedGroups.some((g) => userGroups.includes(g));
}