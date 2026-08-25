import { disableTool } from "eve/tools";

// Every fact this agent uses comes from a specific, checkable Steam/ProtonDB/
// HowLongToBeat call. Open-ended web search would let it answer from
// unverified sources instead, which breaks the "every number comes from a
// tool" contract in instructions.md.
export default disableTool();
