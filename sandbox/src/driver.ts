// OpenCode workspace driver backed by one Docker (gVisor) container per
// visitor, adapted from opencode-github's Modal driver
// (anomalyco/anomaly: opencode-github/src/agent/workspace-driver.ts).
// OpenCode supplies only a process spawner per workspace; its shell, read,
// write, edit, glob and grep tools all run through it, so every tool call
// executes inside the visitor's container and never on the VM.
import { randomUUID } from "node:crypto"
import { basename, isAbsolute } from "node:path"
import { Effect, PlatformError, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
// @opencode/core ships no type declarations; this is its WorkspaceDriver.
// @ts-ignore
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import * as broker from "./broker-client"

export const PROVIDER = "docker"
const PREFIX = "wrk_"
export const workspaceId = (visitorId: string) => `${PREFIX}${visitorId}`

const visitorOf = (workspaceID: string): string | undefined => {
  const id = workspaceID.startsWith(PREFIX) ? workspaceID.slice(PREFIX.length) : ""
  return /^[a-f0-9]{16}$/.test(id) ? id : undefined
}

const unavailable = (method: string, cause?: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "Workspace",
    method,
    description: "The sandbox is unavailable.",
    ...(cause === undefined ? {} : { cause }),
  } as any)

const forwardableEnv = (env: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        /^(LC_[A-Z]+|LANG|LANGUAGE|TERM|NO_COLOR|FORCE_COLOR|COLUMNS|LINES|GIT_PAGER|PAGER)$/.test(entry[0]),
    ),
  )

// OpenCode hands the spawner host paths (its bundled rg, the host's shell);
// inside the container only the program name means anything.
const program = (command: string) => {
  if (!isAbsolute(command)) return command
  const name = basename(command)
  return name === "zsh" || name === "fish" ? "bash" : name
}

const stdinStream = (input: any) =>
  Stream.isStream(input)
    ? input
    : typeof input === "object" && input !== null && "stream" in input && Stream.isStream(input.stream)
      ? input.stream
      : undefined
const stdinIgnored = (input: any) =>
  input === "ignore" || (typeof input === "object" && input !== null && "stream" in input && input.stream === "ignore")

export const makeSpawner = (visitorId: string) =>
  ChildProcessSpawner.make((command: any) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.fail(unavailable("spawn"))
      const marker = randomUUID()
      const proc = yield* Effect.tryPromise({
        try: () =>
          broker.exec({
            id: visitorId,
            argv: [program(command.command), ...command.args],
            ...(command.options.cwd ? { cwd: command.options.cwd } : {}),
            env: forwardableEnv(command.options.env),
            marker,
          }),
        catch: (e) => unavailable("spawn", e),
      })
      let running = true
      const exited = proc.exited.then(
        (code) => code,
        () => null,
      )
      exited.finally(() => {
        running = false
      })
      const exitCode = Effect.promise(() => exited).pipe(
        Effect.flatMap((code) =>
          code === null
            ? Effect.fail(unavailable("exitCode"))
            : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        ),
      )
      const kill = (signal: string) =>
        Effect.tryPromise({
          try: () => broker.op({ op: "kill", id: visitorId, marker, signal }),
          catch: (e) => unavailable("kill", e),
        }).pipe(Effect.asVoid)
      // Like a local child, a process outliving its scope is killed.
      yield* Effect.addFinalizer(() =>
        running ? kill("KILL").pipe(Effect.timeout("30 seconds"), Effect.ignore) : Effect.void,
      )

      let stdinClosed = false
      const closeStdin = Effect.sync(() => {
        if (stdinClosed) return
        stdinClosed = true
        proc.closeStdin()
      })
      const stdin = Sink.forEach((chunk: Uint8Array) => Effect.sync(() => proc.writeStdin(chunk))).pipe(
        Sink.ensuring(closeStdin),
      )
      const read = (stream: ReadableStream<Uint8Array>) =>
        Stream.fromReadableStream({ evaluate: () => stream, onError: (e) => unavailable("read", e) })
      const stdout = read(proc.stdout)
      const stderr = read(proc.stderr)

      const input = command.options.stdin
      const stream = stdinStream(input)
      if (stream) yield* Stream.run(stream, stdin).pipe(Effect.catch(() => closeStdin), Effect.forkScoped)
      else if (stdinIgnored(input)) yield* closeStdin

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode,
        isRunning: Effect.sync(() => running),
        kill: (options?: any) => kill(String(options?.killSignal ?? "SIGTERM").replace(/^SIG/, "")),
        stdin,
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      } as any)
    }),
  )

const driverError = (message: string) => new WorkspaceDriver.Error({ message })

export const provider = WorkspaceDriver.make({
  create: ({ workspaceID }: { workspaceID: string }) => {
    const id = visitorOf(workspaceID)
    if (!id) return Effect.fail(driverError("Unknown workspace."))
    return Effect.tryPromise({
      try: () => broker.op({ op: "create", id }),
      catch: (e) => driverError(`Sandbox create failed: ${String(e).slice(0, 200)}`),
    }).pipe(Effect.as({ binding: {} }))
  },
  connect: ({ workspaceID }: { workspaceID: string }) => {
    const id = visitorOf(workspaceID)
    return id ? Effect.succeed({ spawner: makeSpawner(id) }) : Effect.fail(driverError("Unknown workspace."))
  },
  // Visits are short; the gateway destroys the sandbox when the visitor leaves.
  suspendForIdle: () => Effect.void,
  destroy: ({ workspaceID }: { workspaceID: string }) => {
    const id = visitorOf(workspaceID)
    if (!id) return Effect.void
    return Effect.tryPromise({
      try: () => broker.op({ op: "destroy", id }),
      catch: (e) => driverError(String(e).slice(0, 200)),
    })
  },
})
