import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "http://127.0.0.1:9/root-private-mcp",
  description: "Root-only connection canary; never contacted by this fixture.",
});
