import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import mongoose from "mongoose";

import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { ethers } from "ethers";

import { getChainInfo, getEthersProvider } from "./src/environment";
import { findBlockRangeByTimestamp, makeSolanaRpcRequest } from "./src/utils";
import { Asset, Transaction } from "./src/mongodb";

import { Network, ChainId, Wormhole, chainIdToChain, toNative } from "@wormhole-foundation/connect-sdk";
import { SolanaPlatform } from "@wormhole-foundation/connect-sdk-solana";
import { EvmPlatform } from "@wormhole-foundation/connect-sdk-evm";
import { CosmwasmPlatform } from "@wormhole-foundation/connect-sdk-cosmwasm";
import "@wormhole-foundation/connect-sdk-evm-tokenbridge";
import "@wormhole-foundation/connect-sdk-solana-tokenbridge";
import "@wormhole-foundation/connect-sdk-cosmwasm-tokenbridge";

import { SuiClient, getFullnodeUrl } from "@mysten/sui.js/client";
import { getForeignAssetSui, hexToUint8Array } from "./src/sui";

dotenv.config();

interface InfoRequest {
  network: Network;
  chain: string;
  address: string;
  tokenAddress: string;
  timestamp: string;
  amount: string;
  txHash: string;
  sequence: string;
}

interface WrappedAssetRequest {
  network: Network;
  tokenChain: string;
  tokenAddress: string;
  targetChain: string;
}

const connectToDatabase = async () => {
  try {
    await mongoose.connect(
      `mongodb+srv://${process.env.MONGO_CREDENTIALS}/wrappedAssets?retryWrites=true&w=majority`,
    );
    console.log("Connected to MongoDB correctly");
    return true;
  } catch (err) {
    console.error("Error connecting to MongoDB", err);
    return false;
  }
};

async function runServer() {
  // EXPRESS ENDPOINTS CONNECTIONS
  const app = express();
  app.use(express.json({ strict: false }));
  app.use(cors());

  app.get("/", (req, res) => {
    res.send("hey there");
  });

  app.get("/getRedeemTxn", async (req, res) => {
    const request = { ...req.query } as unknown as InfoRequest;
    console.log("Request getRedeemTxn with parameters:", JSON.stringify(request));

    if (
      !request.network ||
      !request.chain ||
      !request.address ||
      !request.tokenAddress ||
      !request.timestamp ||
      !request.amount ||
      !request.txHash ||
      !request.sequence
    ) {
      res.send(
        "Missing parameters, we need to have: network, chain, address, tokenAddress, timestamp, amount, txHash, sequence",
      );
      return;
    }

    try {
      const { address, chain, network, tokenAddress, timestamp, amount, txHash, sequence } = request;

      const savedTransaction = await Transaction.findOne({ txHash });

      if (savedTransaction) {
        console.log("found existing redeem txn", savedTransaction.data);
        res.send(savedTransaction.data);
        return;
      }

      // SOLANA GET REDEEM TXN HASH
      if (chain === "1") {
        // get transfers for the address
        const { result } = await makeSolanaRpcRequest(network, "getSignaturesForAddress", [address]);

        // filter the ones older than source tx timestamp
        const signaturesDetails = result?.filter(a => a.blockTime > Date.parse(timestamp) / 1000 - 1000);

        let redeemTxHash: string | null = null;
        if (signaturesDetails) {
          // list of tx hashes
          let signatures = signaturesDetails.map(tx => tx.signature);
          console.log("amount of txs on time", signatures?.length);

          // prevent more than 100 requests, last 50 txns and the 50 closer to the timestamp
          if (signatures.length > 100) {
            signatures = [
              ...signatures.slice(0, 50),
              ...signatures.slice(signatures.length - 51, signatures.length - 1),
            ];
          }

          for (const sig of signatures) {
            const { result: txInfo } = await makeSolanaRpcRequest(network, "getTransaction", [
              sig,
              { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
            ]);

            console.log(`sig: ${sig}, blockTime: ${txInfo?.blockTime}`);

            if (!!txInfo?.meta?.innerInstructions?.length) {
              for (const innerInstruction of txInfo?.meta?.innerInstructions) {
                if (!!innerInstruction?.instructions?.length) {
                  for (const instruction of innerInstruction.instructions) {
                    // console.log({
                    //   type: instruction.parsed?.type,
                    //   mint: instruction.parsed?.info?.mint?.toLowerCase(),
                    //   tokenAddress,
                    //   amount: amount,
                    //   instAmount: +instruction.parsed?.info?.amount,
                    //   program: instruction.program,
                    // });

                    if (
                      instruction.parsed?.type === "mintTo" &&
                      instruction.parsed?.info?.mint?.toLowerCase() === tokenAddress.toLowerCase() &&
                      Math.abs(+instruction.parsed?.info?.amount - +amount) < 10000 &&
                      instruction.program === "spl-token"
                    ) {
                      if (txInfo.transaction?.signatures && txInfo.transaction?.signatures.length === 1) {
                        redeemTxHash = txInfo.transaction.signatures[0];

                        const newTransaction = new Transaction({
                          txHash,
                          data: {
                            redeemTxHash: redeemTxHash,
                          },
                        });
                        await newTransaction.save();

                        console.log("new solana redeemTxHash found!", redeemTxHash);

                        res.send({ redeemTxHash });
                        return;
                      }
                    }
                  }
                }
              }
            }
          }
        }

        res.status(404).send("redeem txn not found");
        return;
      }

      // EVM GET REDEEM TXN HASH
      const evmChainInfo = getChainInfo(network, +chain as ChainId);
      if (!!evmChainInfo) {
        const ethersProvider = getEthersProvider(evmChainInfo);
        const blockRanges = await findBlockRangeByTimestamp(ethersProvider!, timestamp);

        if (!blockRanges) {
          res.send("unable to find block range for timestamp");
          return null;
        }

        const transferEventSignature = "Transfer(address,address,uint256)";
        const addressToFilter = ethers.zeroPadValue(ethers.getAddress(address), 32);

        const redeemedEventSignature = "Redeemed(uint16,bytes32,uint64)";
        const sequenceToFilter = ethers.zeroPadValue("0x" + BigInt(+sequence).toString(16).padStart(64, "0"), 32);

        let redeemTxHash: string | null = null;
        let logs: Array<ethers.Log> = [];

        for (const blockRange of blockRanges) {
          const filterRedeemed = {
            fromBlock: blockRange[0],
            toBlock: blockRange[1],
            address: address,
            topics: [ethers.id(redeemedEventSignature), null, null, sequenceToFilter],
          };

          const found = await ethersProvider!.getLogs(filterRedeemed);
          if (found.length) {
            redeemTxHash = found[0].transactionHash;

            const newTransaction = new Transaction({
              txHash,
              data: {
                redeemTxHash: redeemTxHash,
              },
            });
            await newTransaction.save();

            console.log("new evm redeemTxHash found!", redeemTxHash);

            res.send({ redeemTxHash });
            return;
          }

          const filterTransfer = {
            fromBlock: blockRange[0],
            toBlock: blockRange[1],
            address: tokenAddress,
            topics: [ethers.id(transferEventSignature), null, addressToFilter],
          };

          logs = [...logs, ...(await ethersProvider!.getLogs(filterTransfer))];
        }

        for (const log of logs) {
          const parsedLog = ethers.AbiCoder.defaultAbiCoder().decode(
            ["uint256"],
            ethers.zeroPadValue(log.data, 32),
          );

          const tokenAmount = BigInt(parsedLog?.[0])?.toString();

          const tokenDecimalsAbi = ["function decimals() view returns (uint8)"];
          const contract = new ethers.Contract(tokenAddress, tokenDecimalsAbi, ethersProvider);
          const [tokenDecimals] = await Promise.all([contract.decimals()]);

          console.log({
            tokenAmountRaw: tokenAmount,
            tokenAmountParsed: ethers.formatUnits(tokenAmount, tokenDecimals),
            wormholeAmount: amount,
            wormholeAmountParsed: ethers.formatUnits(amount, 8),
          });

          if (
            Math.abs(+tokenAmount - +amount) < 200000 ||
            Math.abs(+ethers.formatUnits(tokenAmount, tokenDecimals || 8) - +ethers.formatUnits(amount, 8)) < 1
          ) {
            redeemTxHash = log.transactionHash;

            const newTransaction = new Transaction({
              txHash,
              data: {
                redeemTxHash: redeemTxHash,
              },
            });
            await newTransaction.save();

            console.log("new evm redeemTxHash found!", redeemTxHash);

            res.send({ redeemTxHash });
            return;
          }
        }
      }

      res.status(404).send("redeem txn not found");
    } catch (err) {
      console.error("catch!!", err);
      res.status(404).send(`error getting info: ${err}`);
    }
  });

  app.get("/getWrappedAsset", async (req, res) => {
    const request = { ...req.query } as unknown as WrappedAssetRequest;
    console.log("Request getWrappedAsset with parameters:", JSON.stringify(request));

    if (!request.tokenChain || !request.tokenAddress || !request.network || !request.targetChain) {
      res.send("Missing parameters, we need to have: tokenChain, tokenAddress, network, targetChain");
      return;
    }

    try {
      const { network, tokenChain, tokenAddress, targetChain } = request;

      const savedAsset = await Asset.findOne({
        network,
        address: tokenAddress,
        targetChain: targetChain,
      });

      if (savedAsset) {
        console.log(
          `FOUND EXISTING: address ${savedAsset.data.wrappedToken}${
            savedAsset.data.tokenSymbol ? ` with symbol ${savedAsset.data.tokenSymbol}` : ""
          }`,
        );

        res.send(savedAsset.data);
        return;
      }

      const wh = new Wormhole(network.toLowerCase() === "mainnet" ? "Mainnet" : "Testnet", [
        EvmPlatform,
        SolanaPlatform,
        CosmwasmPlatform,
      ]);

      const tokenList: any = fs.readFileSync("./tokenList.json");
      const parsedTokens = JSON.parse(tokenList);

      const returnAsset = async (wrappedToken: string) => {
        const tokenSymbol = parsedTokens?.[targetChain]?.[wrappedToken.toLowerCase()]?.symbol || "";

        const newAsset = new Asset({
          network,
          address: tokenAddress,
          targetChain,
          data: {
            wrappedToken,
            tokenSymbol,
          },
        });
        await newAsset.save();

        console.log(`FOUND NEW: address ${wrappedToken}${tokenSymbol ? ` with symbol ${tokenSymbol}` : ""}`);
        res.send({
          wrappedToken,
          tokenSymbol,
        });
      };

      // SUI target
      if (targetChain === "21") {
        const which = network.toLowerCase() === "mainnet" ? "mainnet" : "testnet";
        const suiClient = new SuiClient({ url: getFullnodeUrl(which) });
        const tokenBridgeContract = wh.getContracts("Sui")?.tokenBridge;

        const nativeTokenAddress = toNative(chainIdToChain(+tokenChain as ChainId), tokenAddress);

        const foreignAsset = await getForeignAssetSui(
          suiClient,
          tokenBridgeContract!,
          +tokenChain,
          hexToUint8Array(nativeTokenAddress.toUniversalAddress().toString()),
        );

        if (foreignAsset) {
          await returnAsset(foreignAsset);
          return;
        }
      }

      // EVM, SOLANA, COSMWASM target
      const tokenID = Wormhole.chainAddress(chainIdToChain(+tokenChain as ChainId), tokenAddress);
      const tokenInfo = await wh.getWrappedAsset(chainIdToChain(+targetChain as ChainId), tokenID);

      const foreignAsset = tokenInfo.address.toString();

      if (foreignAsset) {
        await returnAsset(foreignAsset);
        return;
      }

      res.status(404).send("unable to get wrappedAsset");
    } catch (e) {
      console.error("error on getWrappedAsset", e);
      res.status(404).send(`error getWrappedAsset: ${e}`);
    }
  });

  const port = process.env.NODE_ENV === "DEV" ? 8080 : 443;
  console.log(process.env.NODE_ENV);
  const server =
    process.env.NODE_ENV === "DEV"
      ? createHttpServer(app)
      : createHttpsServer(
          {
            key: fs.readFileSync("/etc/letsencrypt/live/cryptotruco.com/privkey.pem"),
            cert: fs.readFileSync("/etc/letsencrypt/live/cryptotruco.com/fullchain.pem"),
          },
          app,
        );

  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

const isConnected = await connectToDatabase();
if (isConnected) {
  runServer();
} else {
  console.log("server wont turn on, no mongodb connection");
}
