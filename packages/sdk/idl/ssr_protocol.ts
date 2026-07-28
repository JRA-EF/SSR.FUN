/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/ssr_protocol.json`.
 */
export type SsrProtocol = {
  "address": "2dURvmSdHeyaFES5rxaE1zgPSHCBLW5BLNguJ2Tu1mkW",
  "metadata": {
    "name": "ssrProtocol",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "SSR Protocol: independent, Solana-native tokenized-reserve program (DevNet v1)."
  },
  "instructions": [
    {
      "name": "accrueFees",
      "discriminator": [
        136,
        229,
        178,
        88,
        250,
        122,
        35,
        46
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "reserveTokenMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "addDelegate",
      "discriminator": [
        3,
        67,
        128,
        218,
        69,
        139,
        53,
        88
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "delegateAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              },
              {
                "kind": "arg",
                "path": "delegateWallet"
              }
            ]
          }
        },
        {
          "name": "actingDelegate",
          "docs": [
            "and `restricted == true`; see `common::require_reserve_permission`.",
            "Distinct account from `delegate_account` above -- this is the",
            "signer's OWN delegate record (used to check THEIR permission to add",
            "someone else), not the new delegate being created."
          ]
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "delegateWallet",
          "type": "pubkey"
        },
        {
          "name": "permissions",
          "type": "u16"
        },
        {
          "name": "restricted",
          "type": "bool"
        }
      ]
    },
    {
      "name": "collectFees",
      "discriminator": [
        164,
        152,
        207,
        99,
        30,
        186,
        19,
        182
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "reserveTokenMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "managerFeeDestinationTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "managerFeeDestination"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "reserveTokenMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "managerFeeDestination",
          "docs": [
            "must equal `reserve.fee_config.fee_destination`, checked in the handler."
          ]
        },
        {
          "name": "protocolFeeDestinationTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "protocolFeeDestination"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "reserveTokenMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "protocolFeeDestination",
          "docs": [
            "checked in the handler against",
            "`protocol_config.default_protocol_fee_destination` -- closes the gap",
            "flagged in docs/protocol/SECURITY_INVARIANTS.md (was previously",
            "unvalidated, meaning any caller-supplied address could receive the",
            "protocol's fee share)."
          ]
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createReserve",
      "discriminator": [
        26,
        161,
        211,
        19,
        90,
        218,
        112,
        235
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "protocolConfig.reserveCount",
                "account": "protocolConfig"
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "reserveTokenMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "manager",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "metadataUri",
          "type": "string"
        },
        {
          "name": "mintFeeBps",
          "type": "u16"
        },
        {
          "name": "redemptionFeeBps",
          "type": "u16"
        },
        {
          "name": "annualTvlFeeBps",
          "type": "u16"
        },
        {
          "name": "managerFeeShareBps",
          "type": "u16"
        },
        {
          "name": "protocolFeeShareBps",
          "type": "u16"
        },
        {
          "name": "feeDestination",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initializeProtocol",
      "discriminator": [
        188,
        233,
        252,
        106,
        134,
        146,
        202,
        91
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "maxReserveAssets",
          "type": "u8"
        },
        {
          "name": "defaultProtocolFeeBps",
          "type": "u16"
        },
        {
          "name": "defaultProtocolFeeDestination",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initializeReserveAsset",
      "discriminator": [
        132,
        97,
        20,
        176,
        60,
        66,
        180,
        40
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "reserveAsset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "assetMint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "docs": [
            "(bump cached on `Reserve.vault_authority_bump` at `create_reserve`",
            "time, so it's re-derived-and-checked here rather than trusted blind)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "manager",
          "writable": true,
          "signer": true,
          "relations": [
            "reserve"
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "targetWeightBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "mintReserveTokensInKind",
      "discriminator": [
        82,
        128,
        168,
        134,
        57,
        80,
        78,
        76
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "reserveTokenMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "depositorReserveTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "depositor"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "reserveTokenMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "reserveTokensRequested",
          "type": "u64"
        },
        {
          "name": "minReserveTokensOut",
          "type": "u64"
        },
        {
          "name": "maxAssetAmounts",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "pauseReserve",
      "discriminator": [
        83,
        101,
        128,
        118,
        91,
        12,
        31,
        140
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "recordRebalance",
      "discriminator": [
        204,
        206,
        190,
        113,
        78,
        31,
        186,
        2
      ],
      "accounts": [
        {
          "name": "reserve",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "balancesBefore",
          "type": {
            "vec": "u64"
          }
        },
        {
          "name": "note",
          "type": "string"
        }
      ]
    },
    {
      "name": "redeemReserveTokensInKind",
      "discriminator": [
        21,
        0,
        115,
        208,
        40,
        51,
        117,
        251
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "reserveTokenMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "redeemerReserveTokenAccount",
          "writable": true
        },
        {
          "name": "redeemer",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "reserveTokensToRedeem",
          "type": "u64"
        },
        {
          "name": "minAssetAmountsOut",
          "type": {
            "vec": "u64"
          }
        }
      ]
    },
    {
      "name": "removeDelegate",
      "discriminator": [
        94,
        37,
        16,
        59,
        7,
        84,
        97,
        211
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          },
          "relations": [
            "delegateAccount"
          ]
        },
        {
          "name": "delegateAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              },
              {
                "kind": "account",
                "path": "delegateAccount.wallet",
                "account": "delegate"
              }
            ]
          }
        },
        {
          "name": "actingDelegate",
          "docs": [
            "and the target delegate is restricted; see",
            "`common::require_reserve_permission`."
          ]
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "seedReserve",
      "discriminator": [
        87,
        67,
        157,
        53,
        250,
        196,
        116,
        28
      ],
      "accounts": [
        {
          "name": "protocolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  116,
                  111,
                  99,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "reserveTokenMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "docs": [
            "bump from `create_reserve`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              }
            ]
          }
        },
        {
          "name": "managerReserveTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "manager"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "reserveTokenMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "manager",
          "writable": true,
          "signer": true,
          "relations": [
            "reserve"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seedAmounts",
          "type": {
            "vec": "u64"
          }
        },
        {
          "name": "initialReserveTokens",
          "type": "u64"
        }
      ]
    },
    {
      "name": "transferReserveManager",
      "discriminator": [
        17,
        63,
        221,
        227,
        92,
        109,
        25,
        88
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "manager",
          "signer": true,
          "relations": [
            "reserve"
          ]
        }
      ],
      "args": [
        {
          "name": "newManager",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "unpauseReserve",
      "discriminator": [
        196,
        28,
        20,
        63,
        131,
        150,
        107,
        153
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "updateDelegatePermissions",
      "discriminator": [
        93,
        116,
        123,
        8,
        82,
        179,
        14,
        220
      ],
      "accounts": [
        {
          "name": "reserve",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          },
          "relations": [
            "delegateAccount"
          ]
        },
        {
          "name": "delegateAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve"
              },
              {
                "kind": "account",
                "path": "delegateAccount.wallet",
                "account": "delegate"
              }
            ]
          }
        },
        {
          "name": "actingDelegate",
          "docs": [
            "and the target delegate is restricted; see",
            "`common::require_reserve_permission`."
          ]
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newPermissions",
          "type": "u16"
        }
      ]
    },
    {
      "name": "updateMetadata",
      "discriminator": [
        170,
        182,
        43,
        239,
        97,
        78,
        225,
        186
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newMetadataUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "updateTargets",
      "discriminator": [
        170,
        123,
        239,
        96,
        63,
        77,
        103,
        185
      ],
      "accounts": [
        {
          "name": "reserve",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  115,
                  101,
                  114,
                  118,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "reserve.reserveId",
                "account": "reserve"
              }
            ]
          }
        },
        {
          "name": "delegate",
          "docs": [
            "see `common::require_reserve_permission`."
          ]
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newTargetWeightsBps",
          "type": {
            "vec": "u16"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "delegate",
      "discriminator": [
        92,
        145,
        166,
        111,
        11,
        38,
        38,
        247
      ]
    },
    {
      "name": "protocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    },
    {
      "name": "reserve",
      "discriminator": [
        43,
        242,
        204,
        202,
        26,
        247,
        59,
        127
      ]
    },
    {
      "name": "reserveAsset",
      "discriminator": [
        34,
        246,
        146,
        250,
        135,
        15,
        64,
        34
      ]
    }
  ],
  "events": [
    {
      "name": "delegateAdded",
      "discriminator": [
        96,
        159,
        58,
        144,
        26,
        171,
        141,
        70
      ]
    },
    {
      "name": "delegatePermissionsUpdated",
      "discriminator": [
        206,
        115,
        86,
        4,
        49,
        190,
        247,
        80
      ]
    },
    {
      "name": "delegateRemoved",
      "discriminator": [
        91,
        243,
        235,
        175,
        109,
        235,
        217,
        84
      ]
    },
    {
      "name": "feesAccrued",
      "discriminator": [
        1,
        151,
        46,
        93,
        244,
        90,
        12,
        191
      ]
    },
    {
      "name": "feesCollected",
      "discriminator": [
        233,
        23,
        117,
        225,
        107,
        178,
        254,
        8
      ]
    },
    {
      "name": "metadataUpdated",
      "discriminator": [
        132,
        36,
        215,
        246,
        166,
        90,
        189,
        44
      ]
    },
    {
      "name": "protocolInitialized",
      "discriminator": [
        173,
        122,
        168,
        254,
        9,
        118,
        76,
        132
      ]
    },
    {
      "name": "rebalanceRecorded",
      "discriminator": [
        83,
        167,
        13,
        100,
        73,
        195,
        250,
        92
      ]
    },
    {
      "name": "reserveAssetInitialized",
      "discriminator": [
        175,
        200,
        189,
        52,
        236,
        144,
        78,
        134
      ]
    },
    {
      "name": "reserveCreated",
      "discriminator": [
        120,
        8,
        71,
        243,
        135,
        170,
        20,
        99
      ]
    },
    {
      "name": "reserveManagerTransferred",
      "discriminator": [
        42,
        12,
        5,
        11,
        20,
        129,
        0,
        110
      ]
    },
    {
      "name": "reservePaused",
      "discriminator": [
        156,
        26,
        250,
        53,
        56,
        240,
        118,
        141
      ]
    },
    {
      "name": "reserveSeeded",
      "discriminator": [
        193,
        145,
        90,
        8,
        5,
        2,
        185,
        73
      ]
    },
    {
      "name": "reserveTokensMinted",
      "discriminator": [
        201,
        241,
        70,
        254,
        32,
        189,
        226,
        45
      ]
    },
    {
      "name": "reserveTokensRedeemed",
      "discriminator": [
        81,
        210,
        177,
        179,
        45,
        112,
        141,
        204
      ]
    },
    {
      "name": "reserveUnpaused",
      "discriminator": [
        208,
        175,
        14,
        203,
        235,
        229,
        84,
        71
      ]
    },
    {
      "name": "targetsUpdated",
      "discriminator": [
        240,
        156,
        105,
        18,
        132,
        185,
        241,
        70
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "metadataUriTooLong",
      "msg": "Metadata URI exceeds the maximum allowed length."
    },
    {
      "code": 6001,
      "name": "zeroValue",
      "msg": "Value is zero where a nonzero value is required."
    },
    {
      "code": 6002,
      "name": "maxReserveAssetsTooHigh",
      "msg": "Requested max_reserve_assets exceeds the absolute protocol ceiling."
    },
    {
      "code": 6003,
      "name": "protocolPaused",
      "msg": "The protocol is currently paused; this action is not permitted."
    },
    {
      "code": 6004,
      "name": "reserveAssetLimitReached",
      "msg": "This Reserve has reached its configured maximum number of Reserve Assets."
    },
    {
      "code": 6005,
      "name": "duplicateReserveAsset",
      "msg": "This asset mint is already registered as a Reserve Asset for this Reserve."
    },
    {
      "code": 6006,
      "name": "unsupportedTokenProgram",
      "msg": "Unsupported token program for this mint."
    },
    {
      "code": 6007,
      "name": "unsupportedMintExtension",
      "msg": "This Token-2022 mint carries an extension SSR cannot safely account for (e.g. transfer fee or transfer hook)."
    },
    {
      "code": 6008,
      "name": "targetWeightExceedsTotal",
      "msg": "Sum of target weights would exceed 10,000 basis points (100%)."
    },
    {
      "code": 6009,
      "name": "reserveAssetDisabled",
      "msg": "This Reserve Asset is disabled and cannot receive a nonzero target weight."
    },
    {
      "code": 6010,
      "name": "unexpectedReserveStatus",
      "msg": "Reserve is not in the expected status for this action."
    },
    {
      "code": 6011,
      "name": "reservePaused",
      "msg": "Reserve is paused; this action is not permitted while paused."
    },
    {
      "code": 6012,
      "name": "reserveNotPaused",
      "msg": "Reserve is not paused."
    },
    {
      "code": 6013,
      "name": "invalidReserveVault",
      "msg": "The supplied Reserve Vault does not match the expected PDA for this Reserve and asset."
    },
    {
      "code": 6014,
      "name": "reserveAssetMismatch",
      "msg": "The supplied ReserveAsset account does not belong to this Reserve."
    },
    {
      "code": 6015,
      "name": "remainingAccountsMismatch",
      "msg": "Remaining accounts do not match the Reserve's registered asset list (count or order)."
    },
    {
      "code": 6016,
      "name": "seedAmountTooLow",
      "msg": "Seed amount for this asset is below the minimum required seed amount."
    },
    {
      "code": 6017,
      "name": "reserveAlreadySeeded",
      "msg": "Reserve has already been seeded."
    },
    {
      "code": 6018,
      "name": "reserveNotSeeded",
      "msg": "Reserve has not been seeded yet."
    },
    {
      "code": 6019,
      "name": "slippageMinOutputNotMet",
      "msg": "Requested Reserve Token output is below the caller's specified minimum."
    },
    {
      "code": 6020,
      "name": "slippageMaxInputExceeded",
      "msg": "Required input for at least one Reserve Asset exceeds the caller's specified maximum."
    },
    {
      "code": 6021,
      "name": "zeroAmountAfterFeesOrRounding",
      "msg": "Requested mint or redemption amount is zero after fees/rounding."
    },
    {
      "code": 6022,
      "name": "redemptionExceedsEntitlement",
      "msg": "Redemption amount exceeds the caller's proportional entitlement."
    },
    {
      "code": 6023,
      "name": "zeroSupply",
      "msg": "Reserve Token supply is zero; proportional math is undefined until the Reserve is seeded."
    },
    {
      "code": 6024,
      "name": "notReserveManager",
      "msg": "Signer is not the root Reserve Manager for this Reserve."
    },
    {
      "code": 6025,
      "name": "delegatePermissionDenied",
      "msg": "Signer is not an authorized delegate for this action."
    },
    {
      "code": 6026,
      "name": "unrestrictedDelegateRequiresManager",
      "msg": "Only the root Reserve Manager may grant or revoke an unrestricted delegate."
    },
    {
      "code": 6027,
      "name": "reservedPermissionBitSet",
      "msg": "Delegate permission bitmask sets a reserved bit that must be zero in v1."
    },
    {
      "code": 6028,
      "name": "notProtocolAuthority",
      "msg": "Signer is not the ProtocolConfig authority."
    },
    {
      "code": 6029,
      "name": "delegateNotFound",
      "msg": "Cannot remove or modify a delegate that does not exist for this Reserve."
    },
    {
      "code": 6030,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow."
    },
    {
      "code": 6031,
      "name": "mathUnderflow",
      "msg": "Arithmetic underflow."
    },
    {
      "code": 6032,
      "name": "divisionByZero",
      "msg": "Division by zero."
    },
    {
      "code": 6033,
      "name": "feeExceedsMaximum",
      "msg": "Requested fee exceeds the absolute maximum allowed for this fee type."
    },
    {
      "code": 6034,
      "name": "invalidFeeShareSplit",
      "msg": "Manager and protocol fee shares must each be within [0, 10000] basis points."
    },
    {
      "code": 6035,
      "name": "noPendingFees",
      "msg": "There are no pending fee shares to collect."
    },
    {
      "code": 6036,
      "name": "rebalanceMismatch",
      "msg": "Rebalance record does not match the currently pending rebalance intent."
    },
    {
      "code": 6037,
      "name": "noPendingRebalance",
      "msg": "No rebalance intent is currently pending for this Reserve."
    }
  ],
  "types": [
    {
      "name": "delegate",
      "docs": [
        "A scoped, revocable delegate for one Reserve. See",
        "docs/protocol/ACCOUNT_MODEL.md \"Delegate\"."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "permissions",
            "type": "u16"
          },
          {
            "name": "restricted",
            "docs": [
              "`true` for an ordinary scoped delegate; `false` only for an",
              "\"unrestricted\" delegate the root manager has explicitly designated",
              "(may itself add/remove *restricted* delegates, but never the",
              "root-exclusive powers -- see docs/protocol/SSR_ARCHITECTURE.md",
              "section 7)."
            ],
            "type": "bool"
          },
          {
            "name": "addedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "delegateAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "delegate",
            "type": "pubkey"
          },
          {
            "name": "permissions",
            "type": "u16"
          },
          {
            "name": "restricted",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "delegatePermissionsUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "delegate",
            "type": "pubkey"
          },
          {
            "name": "oldPermissions",
            "type": "u16"
          },
          {
            "name": "newPermissions",
            "type": "u16"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "delegateRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "delegate",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feeConfig",
      "docs": [
        "All fee values here are explicit DevNet placeholders, not final economics.",
        "See DEC-0013."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mintFeeBps",
            "type": "u16"
          },
          {
            "name": "redemptionFeeBps",
            "type": "u16"
          },
          {
            "name": "annualTvlFeeBps",
            "type": "u16"
          },
          {
            "name": "managerFeeShareBps",
            "docs": [
              "Manager's share of the collected fee pool, out of BPS_DENOMINATOR."
            ],
            "type": "u16"
          },
          {
            "name": "protocolFeeShareBps",
            "docs": [
              "Protocol's share of the collected fee pool, out of BPS_DENOMINATOR.",
              "`manager_fee_share_bps + protocol_fee_share_bps` need not equal",
              "BPS_DENOMINATOR; any residual is intentionally left unminted (burned",
              "in effect, mirroring the reference protocol's `folioFeeForSelf`",
              "concept) rather than silently dropped or misattributed."
            ],
            "type": "u16"
          },
          {
            "name": "feeDestination",
            "type": "pubkey"
          },
          {
            "name": "lastFeeAccrualTs",
            "docs": [
              "Unix timestamp of the last `accrue_fees` checkpoint. TVL fee accrues",
              "on full elapsed days since this timestamp (discrete daily snapshots,",
              "not continuous per-second streaming -- see",
              "RESERVE_REFERENCE_ANALYSIS.md section 8)."
            ],
            "type": "i64"
          },
          {
            "name": "pendingManagerFeeShares",
            "docs": [
              "Accounted-but-not-yet-minted Reserve Token amounts, owed to the",
              "manager and to the protocol respectively. Only `collect_fees` actually",
              "mints these. See docs/protocol/ACCOUNT_MODEL.md FeeConfig table."
            ],
            "type": "u64"
          },
          {
            "name": "pendingProtocolFeeShares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "feesAccrued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "managerFeeSharesAccrued",
            "type": "u64"
          },
          {
            "name": "protocolFeeSharesAccrued",
            "type": "u64"
          },
          {
            "name": "accruedUntilTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "managerFeeSharesMinted",
            "type": "u64"
          },
          {
            "name": "protocolFeeSharesMinted",
            "type": "u64"
          },
          {
            "name": "managerDestination",
            "type": "pubkey"
          },
          {
            "name": "protocolDestination",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "metadataUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "newMetadataUri",
            "type": "string"
          },
          {
            "name": "updatedBy",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "protocolConfig",
      "docs": [
        "Singleton global configuration account. See docs/protocol/ACCOUNT_MODEL.md",
        "\"ProtocolConfig\" and docs/protocol/SSR_ARCHITECTURE.md section 7 for the",
        "narrow-authority rationale: this account can pause creation/mint",
        "protocol-wide and set defaults for *new* Reserves, but can never move a",
        "single token out of any already-created Reserve's vaults."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "schemaVersion",
            "type": "u8"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "maxReserveAssets",
            "type": "u8"
          },
          {
            "name": "defaultProtocolFeeBps",
            "type": "u16"
          },
          {
            "name": "defaultProtocolFeeDestination",
            "type": "pubkey"
          },
          {
            "name": "reserveCount",
            "docs": [
              "Monotonic counter; also used as the seed for the next `create_reserve`",
              "call's Reserve PDA (`reserve_id`). See DEC-0012."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "protocolInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "maxReserveAssets",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "rebalanceRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "assetMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "balancesBefore",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "balancesAfter",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "executedBy",
            "type": "pubkey"
          },
          {
            "name": "note",
            "type": "string"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reserve",
      "docs": [
        "Canonical per-Reserve state. See docs/protocol/ACCOUNT_MODEL.md \"Reserve\"."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "schemaVersion",
            "type": "u8"
          },
          {
            "name": "reserveId",
            "type": "u64"
          },
          {
            "name": "manager",
            "type": "pubkey"
          },
          {
            "name": "reserveTokenMint",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "reserveStatus"
              }
            }
          },
          {
            "name": "assetCount",
            "type": "u8"
          },
          {
            "name": "totalTargetWeightBps",
            "type": "u16"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "configuredAt",
            "type": "i64"
          },
          {
            "name": "feeConfig",
            "type": {
              "defined": {
                "name": "feeConfig"
              }
            }
          },
          {
            "name": "metadataUri",
            "type": "string"
          },
          {
            "name": "delegateCount",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultAuthorityBump",
            "type": "u8"
          },
          {
            "name": "mintAuthorityBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "reserveAsset",
      "docs": [
        "One basket constituent of a Reserve. See docs/protocol/ACCOUNT_MODEL.md",
        "\"ReserveAsset\"."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "assetMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "tokenProgram",
            "type": {
              "defined": {
                "name": "tokenProgramKind"
              }
            }
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "targetWeightBps",
            "type": "u16"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "orderIndex",
            "docs": [
              "Deterministic registration order -- clients and on-chain iteration",
              "always agree on asset ordering (see docs/protocol/ACCOUNT_MODEL.md)."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "reserveAssetInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "assetMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "targetWeightBps",
            "type": "u16"
          },
          {
            "name": "orderIndex",
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reserveCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "reserveId",
            "type": "u64"
          },
          {
            "name": "manager",
            "type": "pubkey"
          },
          {
            "name": "reserveTokenMint",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reserveManagerTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "oldManager",
            "type": "pubkey"
          },
          {
            "name": "newManager",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reservePaused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "pausedBy",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reserveSeeded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "initialReserveTokens",
            "type": "u64"
          },
          {
            "name": "assetMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "assetAmounts",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reserveStatus",
      "docs": [
        "Tracks resumable multi-step creation (see DEC-0019) and pause state.",
        "`Created -> AssetsInitializing -> Seeded -> Active`, with `Paused` layered",
        "on top of `Active` (a Reserve pauses/unpauses from and back to `Active`",
        "only -- pausing mid-creation is not a reachable state, since creation",
        "itself isn't gated by pause checks)."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "created"
          },
          {
            "name": "assetsInitializing"
          },
          {
            "name": "active"
          },
          {
            "name": "paused"
          }
        ]
      }
    },
    {
      "name": "reserveTokensMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "reserveTokensOut",
            "type": "u64"
          },
          {
            "name": "mintFeeReserveTokens",
            "type": "u64"
          },
          {
            "name": "assetMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "assetAmountsIn",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reserveTokensRedeemed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "redeemer",
            "type": "pubkey"
          },
          {
            "name": "reserveTokensBurned",
            "type": "u64"
          },
          {
            "name": "redemptionFeeReserveTokens",
            "type": "u64"
          },
          {
            "name": "assetMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "assetAmountsOut",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "reserveUnpaused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "unpausedBy",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "targetsUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "reserve",
            "type": "pubkey"
          },
          {
            "name": "assetMints",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "newTargetWeightsBps",
            "type": {
              "vec": "u16"
            }
          },
          {
            "name": "updatedBy",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "tokenProgramKind",
      "docs": [
        "Which token program owns this asset's mint/vault. SSR supports both,",
        "validating Token-2022 extensions at registration time -- see",
        "docs/protocol/SECURITY_INVARIANTS.md for the supported/rejected extension",
        "list and DEC-0011 for the rationale."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "splToken"
          },
          {
            "name": "token2022"
          }
        ]
      }
    }
  ]
};
