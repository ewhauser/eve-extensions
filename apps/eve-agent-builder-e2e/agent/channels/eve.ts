import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import { fixtureAuth } from "../lib/fixture.js";

const authenticateFixture: AuthFn<Request> = () => fixtureAuth();

export default eveChannel({ auth: authenticateFixture });
