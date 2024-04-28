import {
    Commitment,
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";

import {
    ConstantComputeUnitLimit,
    DynamicComputeUnitLimit,
    generateComputeLimitInstruction,
} from "../instructions/compute";
import {
    ConstantPrioritizationFee,
    DynamicPrioritizationFee,
    generatePrioritizationFeeInstruction,
} from "../instructions/fee";

export class TransactionBuilder {
    private connection: Connection | undefined = undefined;
    private instructions: TransactionInstruction[] = [];
    private signers: any[] = [];
    private recentBlockhash: string | undefined = undefined;
    private feePayer: PublicKey | undefined = undefined;
    private commitment: Commitment = "confirmed";
    private useVersionedTx: boolean = false;
    private priorityFeeConfig:
        | ConstantPrioritizationFee
        | DynamicPrioritizationFee
        | undefined = undefined;
    private computeUnitLimitConfig:
        | ConstantComputeUnitLimit
        | DynamicComputeUnitLimit
        | undefined = undefined;

    useVersionedTransaction(useVersioned: boolean): TransactionBuilder {
        this.useVersionedTx = useVersioned;
        return this;
    }

    setConnection(connection: Connection): TransactionBuilder {
        this.connection = connection;
        return this;
    }

    setPriorityFeeConfig(
        config: ConstantPrioritizationFee | DynamicPrioritizationFee
    ): TransactionBuilder {
        this.priorityFeeConfig = config;
        return this;
    }

    setComputeUnitLimitConfig(
        config: ConstantComputeUnitLimit | DynamicComputeUnitLimit
    ): TransactionBuilder {
        this.computeUnitLimitConfig = config;
        return this;
    }

    prependInstruction(
        instruction: TransactionInstruction
    ): TransactionBuilder {
        this.instructions.unshift(instruction);
        return this;
    }

    prependInstructions(
        instructions: Array<TransactionInstruction>
    ): TransactionBuilder {
        instructions.forEach((instruction) =>
            this.prependInstruction(instruction)
        );
        return this;
    }

    appendInstruction(instruction: TransactionInstruction): TransactionBuilder {
        this.instructions.push(instruction);
        return this;
    }

    appendInstructions(
        instructions: Array<TransactionInstruction>
    ): TransactionBuilder {
        instructions.forEach((instruction) =>
            this.appendInstruction(instruction)
        );
        return this;
    }

    addSigner(signer: any): TransactionBuilder {
        this.signers.push(signer);
        return this;
    }

    setRecentBlockhash(blockhash: string): TransactionBuilder {
        this.recentBlockhash = blockhash;
        return this;
    }

    setFeePayer(feePayer: PublicKey): TransactionBuilder {
        this.feePayer = feePayer;
        return this;
    }

    private getConnectionOrThrow = (connection?: Connection) => {
        const _connection = this.connection ?? connection;
        if (!_connection) {
            throw new Error(
                'Either set "recentBlockhash" field manually or provide a connection instance'
            );
        }

        return _connection;
    };

    private async resolveComputeBudgetInstructions(args?: {
        connection?: Connection;
        feePayer?: PublicKey;
        commitment?: Commitment;
    }): Promise<void> {
        if (this.computeUnitLimitConfig) {
            const computeUnitLimitInstruction =
                await generateComputeLimitInstruction(
                    this.getConnectionOrThrow(args?.connection),
                    this.instructions,
                    this.computeUnitLimitConfig
                );

            if (computeUnitLimitInstruction) {
                this.prependInstruction(computeUnitLimitInstruction);
            }
        }

        if (this.priorityFeeConfig) {
            const priorityFeeInstruction =
                await generatePrioritizationFeeInstruction(
                    this.getConnectionOrThrow(args?.connection),
                    this.instructions,
                    this.priorityFeeConfig
                );

            this.prependInstruction(priorityFeeInstruction);
        }
    }

    private async buildTransaction(args?: {
        connection?: Connection;
        feePayer?: PublicKey;
        commitment?: Commitment;
    }): Promise<Transaction> {
        const transaction = new Transaction();

        await this.resolveComputeBudgetInstructions(args);
        transaction.add(...this.instructions);

        if (!this.feePayer && !args?.feePayer)
            console.warn("Transaction built with missing fee payer");
        transaction.feePayer = this.feePayer ?? args?.feePayer;

        if (!this.recentBlockhash) {
            const { blockhash } = await this.getConnectionOrThrow(
                args?.connection
            ).getLatestBlockhash({
                commitment: args?.commitment || this.commitment,
            });

            transaction.recentBlockhash = blockhash;
        }

        this.signers.forEach((signer) => transaction.sign(signer));

        return transaction;
    }

    private async buildVersionedTransaction(args?: {
        connection?: Connection;
        feePayer?: PublicKey;
        commitment?: Commitment;
    }): Promise<VersionedTransaction> {
        const feePayer = this.feePayer ?? args?.feePayer;
        if (!feePayer) {
            throw new Error(
                "Versioned Transaction cannot be built with missing fee payer"
            );
        }

        await this.resolveComputeBudgetInstructions(args);

        const { blockhash } = await this.getConnectionOrThrow(
            args?.connection
        ).getLatestBlockhash({
            commitment: args?.commitment || this.commitment,
        });

        const transaction = new VersionedTransaction(
            new TransactionMessage({
                payerKey: feePayer,
                recentBlockhash: blockhash,
                instructions: this.instructions,
            }).compileToV0Message()
        );

        this.signers.forEach((signer) => transaction.sign(signer));

        return transaction;
    }

    async build(args: {
        connection?: Connection;
        feePayer?: PublicKey;
        commitment?: Commitment;
    }): Promise<Transaction | VersionedTransaction> {
        if (this.useVersionedTx) {
            return this.buildVersionedTransaction(args);
        }
        return this.buildTransaction(args);
    }
}
