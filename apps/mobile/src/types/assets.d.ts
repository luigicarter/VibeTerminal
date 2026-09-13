/**
 * Metro resolves image imports to an asset registry id. Expo ships no ambient
 * declaration for them, so the app declares the ones it uses.
 */
declare module '*.png' {
  const asset: number;
  export default asset;
}
