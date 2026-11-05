declare module 'input' {
  interface InputOptions {
    default?: string | boolean;
    [key: string]: any;
  }

  export function text(message: string, options?: InputOptions): Promise<string>;
  export function password(message: string, options?: InputOptions): Promise<string>;
  export function confirm(message: string, options?: InputOptions): Promise<boolean>;
  export function select(message: string, choices: string[], options?: InputOptions): Promise<string>;
  export function checkboxes(message: string, choices: string[], options?: InputOptions): Promise<string[]>;

  const input: {
    text: typeof text;
    password: typeof password;
    confirm: typeof confirm;
    select: typeof select;
    checkboxes: typeof checkboxes;
  };

  export default input;
}
