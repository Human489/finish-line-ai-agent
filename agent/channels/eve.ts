import { localDev, none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

/**
 * Public demo agent. It reads only public Steam profile data and stores
 * nothing about the caller, so anonymous access is admitted explicitly.
 * Replace `none()` with a real authenticator before putting private data
 * behind this agent.
 */
export default eveChannel({
  auth: [localDev(), none()],
});
