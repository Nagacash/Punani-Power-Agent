/**
 * What the agent is told when the project changes.
 *
 * The conversation carries over, and the model has no other way of knowing
 * that the files, the instructions and the skills now belong to a different
 * project. Without this it goes on with the work of the old one.
 */
export function projectChangedNote(root: string): string {
  return (
    `[the project changed to ${root}]\n` +
    "The files, the instructions and the skills now belong to that project. " +
    "Work in that project from now on. What you were doing in the previous one " +
    "stays there, unless the user says it should carry over."
  )
}
