/**
 * What a tool says after it stopped on an error it did not expect (the storage did not answer, a file could not
 * be written): whether anything was saved, and whether calling it again is safe. Added to the error by the tool
 * server (server.ts). A refusal a tool words itself already says what was and was not saved, and is left alone.
 */

/** Tools that change nothing: an error in one leaves everything as it was. */
const isReadTool = (name: string) => /^(?:list_|read_|get_|search_)/.test(name) || ["load_context", "resume_health_check", "check_resume_layout", "setup_status", "reconcile_sources", "prepare_extraction"].includes(name);

/**
 * What a tool that stopped on an unexpected error adds to the error: whether anything was saved, and whether
 * calling it again is safe. A tool that writes does so in more than one step (the file, then the list that
 * names it; in a Drive, the file, then the folder's map), so an error can come after part of the write.
 */
export function afterStop(name: string): string {
  if (isReadTool(name)) return "Nothing was changed. Calling this tool again is safe.";
  const special: Record<string, string> = {
    save_score:
      "The score may or may not have been saved. Call read_application to see whether it is there before saving again: saving it again when it was saved adds a second version of the same score.",
    capture_job_ad:
      "The application may or may not have been created. Call list_applications to see whether it is there. Capturing the same posting again (same company, role and link) is safe: it uses the same application and writes the posting again.",
    set_application_status: "The status may or may not have been changed. Call read_application to see it. Setting the same status again is safe.",
    set_application_track: "The track may or may not have been changed. Call read_application to see it. Setting the same track again is safe.",
    set_referral_message_state: "The state may or may not have been changed. Setting the same state again is safe.",
    save_first_import: "Part of the import may have been saved. Call list_experiences to see what is there, then save what is missing one by one (save_profile, save_experience, save_education).",
  };
  return special[name] ?? "This stopped before it finished, so part of it may have been saved. Calling the tool again with the same input writes the same content again: it is safe, and it is the way to finish. A save that asks for the user's approval asks again.";
}
