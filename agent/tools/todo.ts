import { disableTool } from "eve/tools";

// A backlog question is answered in one turn from tool results. There is no
// multi-step plan for the model to track, and a stray todo list only adds
// tool calls against a metered free-tier quota.
export default disableTool();
