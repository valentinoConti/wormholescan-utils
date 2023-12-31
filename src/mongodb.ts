import mongoose from "mongoose";

const assetSchema = new mongoose.Schema({
  network: String,
  address: String,
  targetChain: String,
  data: mongoose.Schema.Types.Mixed,
});

export const Asset = mongoose.model("Asset", assetSchema);

const transactionSchema = new mongoose.Schema({
  txHash: String,
  data: mongoose.Schema.Types.Mixed,
});

export const Transaction = mongoose.model("Transaction", transactionSchema);
