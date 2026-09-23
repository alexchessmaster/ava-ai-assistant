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
 *
 * The description opens by naming the *question* case, not just the act case.
 * Framed only as "open an application or run a program", a capable model can
 * answer "how much disk space do I have left?" with "I don't have access to
 * your local files" — a question about the machine does not obviously read as a
 * request to run something. Naming the kinds of question, and giving a
 * registered name that answers one, closes that gap.
 *
 * Measured, honestly: `gemma4:e4b` on Ollama already called this tool for that
 * exact question with the *previous* wording, so this text is not the fix for a
 * model that refuses — check the wiring (AGENTS.md §2e, README §7) before
 * blaming the prompt. The rewrite is here because it names the case the old one
 * left implicit, not because it was measured to change an outcome.
 */
export function createRunCommandTool({ names = [] }: { names?: string[] } = {}): ToolDefinition {
  const registered = names.length
    ? `The user has registered these names: ${names.join(", ")}. When their request is about ` +
      `one of them, pass that name rather than a generic command — "how much space do I have ` +
      `left?" is \`disk space\`, not a refusal, and "how's the weather" is \`weather\`, not a web ` +
      `search. A name that already fits beats inventing one. `
    : "";

  return {
    name: "run_command",
    description:
      `${registered}You are running on the user's own computer, and this is how you act on it and ` +
      `read it. Use it to answer questions about their machine when a command can answer them — ` +
      `free disk space, memory, what is running, the files in a folder, their IP address, uptime, a ` +
      `git status; to open an application ("open vscode" is \`code\`); to look something up in their ` +
      `browser ("search for capybaras"); and to run a command they dictated. Pass the user's own name ` +
      `for it if they have one, or the command itself; either works. To pass an argument, put it after ` +
      `the name, as in \`vscode ~/notes.md\`. Something that is neither registered nor previously ` +
      `approved is shown to the user for approval before it runs, so pass the real command rather than ` +
      `guessing at whether it is allowed. When the result carries output, answer the question from ` +
      `that text. Never reply that you cannot access their computer, their files, or their system, ` +
      `and never tell them to run a command themselves — you can, through this tool, so run it.`,
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
