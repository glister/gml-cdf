// Ambient types for CSS Modules imported by web-only (`*.web.tsx`) components.
// Expo/Metro supplies these at runtime; declared here so `tsc` is self-contained
// without the generated `expo-env.d.ts`.
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
