// Ambient types for Hotpress import suffixes. Add "@benchadfield/hotpress/client" to compilerOptions.types.
declare module "*?client" {
  const script: import("@benchadfield/hotpress").ClientScript;
  export default script;
}
declare module "*.svg" {
  const svg: string;
  export default svg;
}
