/** A bundled image, as Metro hands it to `Image`. */
declare module '*.png' {
  const source: import('react-native').ImageSourcePropType
  export default source
}
