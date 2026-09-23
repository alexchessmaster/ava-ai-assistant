import type { ToolDefinition, ToolResult } from "./ToolRegistry";

// A command's output goes into the model's context, and a local model's window
// is small: `ls -R` on a big directory can be thousands of lines. The card shows
// a little more than the model reads, but both are bounded.
const MODEL_OUTPUT_CHARS = 1500;
const CARD_OUTPUT_CHARS = 4000;

/**
 * `names` are the user's own names for things — never the commands or URLs
 * behind them, which stay on the machine.
 *
 * The list rides in the description for the same reason the snippet tool's
 * triggers do: without it the model can only guess, and a guess that happens to
 * be a *different* alias wins by its first word. Asked "how's the weather", a
 * model that cannot see the name `weather` sends `search for weather`, which
 * matches the user's `search` alias and opens a web search instead of the page
 * they set up.
 */
export function createRunCommandTool({ names = [] }: { names?: string[] } = {}): ToolDefinition {
  const registered = names.length
    ? `The user has registered these names: ${names.join(", ")}. When their request is about ` +
      `one of them, pass that name rather than a generic command — "how's the weather" is ` +
      `\`weather\`, not a web search, and a name that already fits beats inventing one. `
    : "";

  return {
    name: "run_command",
    description:
      `${registered}Open an application, run a program, or look something up in the user's browser — ` +
      `"open vscode" is \`code\`, "search for capybaras" opens a web search. Pass the user's own name ` +
      `for it if they have one, or the command itself; either works. To pass an argument, put it after ` +
      `the name, as in \`vscode ~/notes.md\`. Something that is neither registered nor previously ` +
      `approved is shown to the user for approval before it runs, so pass the real command rather than ` +
      `guessing at whether it is allowed. When the result carries output, answer the question from ` +
      `that text — never reply that you cannot see their computer.`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The program to open, or the user's registered name for it, plus any arguments — e.g. `code`, `vscode ~/notes.md`, `weather`, `search tallest mountain`. One thing at a time.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const request = typeof args.command === "string" ? args.command.trim() : "";
      if (!request) {
        return { success: false, data: null, displayText: "No command was given." };
      }

      // Main decides: it checks the user's alias file, asks them when the request
      // is not already allowed, and only then launches. Nothing here is trusted.
      const runCommand = window.electronAPI?.runCommand;
      if (typeof runCommand !== "function") {
        return { success: false, data: null, displayText: "Running commands is unavailable here." };
      }

      const result = await runCommand(request);
      const captured = result.capture;
      return {
        success: result.ok,
        data: result.ok
          ? {
              command: request,
              status: captured ? "ran" : "launched",
              // What the model reads, capped: `data` is what reaches it on both
              // the cloud and the AI-SDK path, so the output has to live here.
              ...(captured
                ? {
                    output: captured.output.slice(0, MODEL_OUTPUT_CHARS),
                    truncated: captured.truncated || captured.output.length > MODEL_OUTPUT_CHARS,
                    timedOut: captured.timedOut === true,
                    exitCode: captured.exitCode,
                  }
                : {}),
            }
          : null,
        displayText: captured
          ? `${result.message}\n\n${captured.output.slice(0, CARD_OUTPUT_CHARS) || "(no output)"}`
          : result.message,
      };
    },
  };
}
