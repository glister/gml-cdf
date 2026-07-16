// CommonJS: Babel config must be CJS (this app does not set "type":"module").
// babel-preset-expo wires up React Compiler + react-native-worklets (Reanimated)
// automatically; `jsxImportSource: 'nativewind'` + `nativewind/babel` enable the
// `className` prop.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
  };
};
