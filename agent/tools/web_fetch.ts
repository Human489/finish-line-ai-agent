import { disableTool } from "eve/tools";

// This agent talks to Steam/ProtonDB/HowLongToBeat through its own authored
// tools, which control exactly which hosts get called. An unrestricted
// fetch-any-URL tool has no legitimate role here and only adds SSRF surface.
export default disableTool();
