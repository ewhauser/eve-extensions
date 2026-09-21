import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// just-bash 3.4.2's public Bash.exec loses the distinction between a normal
// shell exit and an interpreter failure. The transactional host needs it.
// This build-only patch rethrows the seven typed ExecutionLimitError result
// conversions, plus stack/cleanup failures. No upstream package is edited.
// The digest and exact occurrence counts make an upgrade fail closed.
export const portableBash = {
  name: "celld-just-bash-failure-semantics",
  setup(build) {
    build.onLoad(
      { filter: /just-bash\/dist\/bundle\/browser\.js$/ },
      async ({ path }) => {
        let source = await readFile(path, "utf8");
        const digest = createHash("sha256").update(source).digest("hex");
        if (
          digest !==
          "6390563a926e5018d5bc2e8b824ae1b13b87bdd3ed31857bacef31b3c100f224"
        )
          throw new Error(
            "just-bash portable bundle changed; review the failure-semantics patch before upgrading",
          );
        function replace(before, after, count) {
          if (source.split(before).length - 1 !== count)
            throw new Error(`just-bash patch mismatch: ${before}`);
          source = source.split(before).join(after);
        }
        replace(
          "exitCode:C.EXIT_CODE",
          'exitCode:(()=>{throw new C("celld: interpreter execution limit exceeded","commands")})()',
          7,
        );
        replace(
          "if(y instanceof RangeError)return l(",
          "if(y instanceof RangeError)throw y;if(false)return l(",
          1,
        );
        replace(
          "if(y instanceof ye)return l(",
          "if(y instanceof ye)throw y;if(false)return l(",
          1,
        );
        replace(
          "try{await r.close()}catch{i={...s,stderr:",
          "try{await r.close()}catch(error){throw error;i={...s,stderr:",
          1,
        );
        return { contents: source, loader: "js" };
      },
    );
  },
};
