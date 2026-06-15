interface StdoutTakeoverState {
  originalStdoutWrite: typeof process.stdout.write;
  rawStderrWrite: (
    chunk: string,
    callback?: (error?: Error | null) => void,
  ) => boolean;
  rawStdoutWrite: (
    chunk: string,
    callback?: (error?: Error | null) => void,
  ) => boolean;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

export async function flushRawStdout(): Promise<void> {
  if (stdoutTakeoverState) {
    await new Promise<void>((resolve, reject) => {
      stdoutTakeoverState?.rawStdoutWrite("", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    process.stdout.write("", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function isStdoutTakenOver(): boolean {
  return stdoutTakeoverState !== undefined;
}

export function restoreStdout(): void {
  if (!stdoutTakeoverState) {
    return;
  }

  process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
  stdoutTakeoverState = undefined;
}

export function takeOverStdout(): void {
  if (stdoutTakeoverState) {
    return;
  }

  const rawStdoutWrite = process.stdout.write.bind(
    process.stdout,
  ) as StdoutTakeoverState["rawStdoutWrite"];
  const rawStderrWrite = process.stderr.write.bind(
    process.stderr,
  ) as StdoutTakeoverState["rawStderrWrite"];
  const originalStdoutWrite = process.stdout.write;

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: ((error?: Error | null) => void) | BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean => {
    if (typeof encodingOrCallback === "function") {
      return rawStderrWrite(String(chunk), encodingOrCallback);
    }
    return rawStderrWrite(String(chunk), callback);
  }) as typeof process.stdout.write;

  stdoutTakeoverState = {
    originalStdoutWrite,
    rawStderrWrite,
    rawStdoutWrite,
  };
}

export function writeRawStdout(text: string): void {
  if (stdoutTakeoverState) {
    stdoutTakeoverState.rawStdoutWrite(text);
    return;
  }
  process.stdout.write(text);
}
