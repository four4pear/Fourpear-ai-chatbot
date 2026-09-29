import { createInterface } from "node:readline";

/**
 * Terminalden gizli giriş (ör. API anahtarı): yazılanlar ekranda görünmez, komut geçmişine
 * ve sohbete düşmez.
 */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    // readline'ın yankısını kapat: yalnızca soru yazılır.
    const output = rl as unknown as { _writeToOutput: (s: string) => void };
    let asked = false;
    output._writeToOutput = (s: string) => {
      if (!asked) process.stdout.write(s);
      asked = true;
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
