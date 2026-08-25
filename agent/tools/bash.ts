import { disableTool } from "eve/tools";

// This agent only ever needs Steam/HTTP data. It has no legitimate reason to
// run shell commands, and eve grants every agent this tool by default unless
// explicitly disabled.
export default disableTool();
