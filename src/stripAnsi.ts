const oscSequence = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const csiSequence = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const shortEscapeSequence = /\u001B(?:[()][0-2A-Z0-9]|[=>])/g;

export function stripAnsi(value: string): string {
  return value
    .replace(oscSequence, "")
    .replace(csiSequence, "")
    .replace(shortEscapeSequence, "");
}
