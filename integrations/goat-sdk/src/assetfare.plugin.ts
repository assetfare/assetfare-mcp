import { Chain, PluginBase } from "@goat-sdk/core";
import { AssetFareService } from "./assetfare.service.js";

export interface AssetFarePluginOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export class AssetFarePlugin extends PluginBase {
  constructor(options: AssetFarePluginOptions = {}) {
    super("assetfare", [new AssetFareService(options.apiBaseUrl, options.fetch)]);
  }

  supportsChain = (_chain: Chain) => true;
}

export function assetfare(options: AssetFarePluginOptions = {}) {
  return new AssetFarePlugin(options);
}
