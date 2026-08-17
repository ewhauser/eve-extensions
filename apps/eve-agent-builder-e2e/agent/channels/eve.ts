import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import { fixtureAuth } from "../lib/fixture.js";

const authenticateFixture: AuthFn<Request> = (request) =>
  fixtureAuth(request.headers.get("x-fixture-principal") ?? undefined);

export default eveChannel({ auth: authenticateFixture });
