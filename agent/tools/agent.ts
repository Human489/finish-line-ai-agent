import { disableTool } from "eve/tools";

// Delegating to a fresh copy of this agent would duplicate the whole tool
// loop — including the expensive achievement sweep — against a metered
// free-tier quota, for a task that is already a single linear pass.
export default disableTool();
