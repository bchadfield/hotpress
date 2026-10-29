// Ambient types for Hotpress import suffixes. Add "hotpress/client" to compilerOptions.types.
declare module "*?client" {
  const script: import("hotpress").ClientScript;
  export default script;
}
declare module "*.svg" {
  const svg: string;
  export default svg;
}
