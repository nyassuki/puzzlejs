// Disable warnings
process.removeAllListeners('warning');

const fs = require('fs');
const _ = require('lodash');
const secp256k1 = require('secp256k1');
const bitcoin = require('bitcoinjs-lib');
const cluster = require('cluster');
const crypto = require('crypto');
const path = require('path');

const numOfWorkers = 8;
const updateEvery = 1; // Update interval in seconds
const addressFile = "target.txt";
const progressFile = "progress.json";
const random = false; // Set to false for sequential search
const keySpace = "20000000000000000:3ffffffffffffffff";
const FOUND_FILE = "found.txt";
const formatter = new Intl.NumberFormat('en', { notation: 'compact' });

// Create found directory if it doesn't exist
if (!fs.existsSync('found')) {
    fs.mkdirSync('found');
}

// Read addresses from file
const targetAddresses = fs.readFileSync(addressFile, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
        try {
            return line.length > 0 && bitcoin.address.toOutputScript(line);
        } catch(e) {
            return false;
        }
    });

if (targetAddresses.length === 0) {
    console.error("Error: No valid addresses found in the address file");
    process.exit(1);
}

// Load or initialize progress
let progress = {
    startTime: Date.now(),
    totalKeys: 0,
    currentKey: keySpace.split(":")[0],
    lastSaved: Date.now()
};

try {
    if (fs.existsSync(progressFile)) {
        const savedProgress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        progress = {
            ...progress,
            ...savedProgress,
            startTime: savedProgress.startTime || Date.now()
        };
        console.log("Resuming from saved progress:", progress.currentKey);
    }
} catch (e) {
    console.log("Could not load progress file, starting fresh");
}

function saveProgress() {
    try {
        fs.writeFileSync(progressFile, JSON.stringify({
            startTime: progress.startTime,
            totalKeys: progress.totalKeys,
            currentKey: progress.currentKey
        }, null, 2));
        progress.lastSaved = Date.now();
    } catch (e) {
        console.error("Error saving progress:", e.message);
    }
}

function privateKeyToAddress(key) {
    try {
        const privateKey = Buffer.from(key, 'hex');
        const publicKey = secp256k1.publicKeyCreate(privateKey, false);
        const publicKeyHash = bitcoin.crypto.hash160(publicKey);
        return bitcoin.payments.p2pkh({ hash: publicKeyHash }).address;
    } catch (e) {
        return null;
    }
}

function getRandomHexInRange(min, max) {
    const range = BigInt(max) - BigInt(min);
    const randomBuffer = crypto.randomBytes(8);
    const randomBigInt = BigInt('0x' + randomBuffer.toString('hex'));
    const result = (randomBigInt % range) + BigInt(min);
    return result.toString(16).padStart(64, '0');
}

function saveFoundKey(privateKey, address) {
    const content = `Private Key: ${privateKey}\nAddress: ${address}\n\n`;
    fs.appendFileSync(path.join('found', FOUND_FILE), content, 'utf8');
}

if (cluster.isMaster) {
    console.log(`Starting ${numOfWorkers} workers...`);
    for (let i = 0; i < numOfWorkers; i++) {
        cluster.fork();
    }

    console.log("Start Time:", new Date(progress.startTime).toLocaleString());
    console.log("Target addresses:", targetAddresses.join(", "));
    console.log("Key space:", keySpace);
    console.log("Starting from:", progress.currentKey);

    // Save progress periodically
    const progressInterval = setInterval(() => {
        saveProgress();
    }, 60000); // Save every minute

    // Display progress
    const displayInterval = setInterval(() => {
        const elapsedSeconds = (Date.now() - progress.startTime) / 1000;
        const rate = progress.totalKeys / elapsedSeconds;
        
        process.stdout.write("\r" + [
            "Keys:", formatter.format(progress.totalKeys),
            "| Rate:", formatter.format(Math.trunc(rate)), "keys/s",
            "| Current:", progress.currentKey.substring(0, 16) + "...",
            "| Last saved:", new Date(progress.lastSaved).toTimeString().split(' ')[0]
        ].join(" "));
    }, updateEvery * 1000);

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} exited`);
    });

    cluster.on('message', (worker, message) => {
        if (message.found) {
            clearInterval(progressInterval);
            clearInterval(displayInterval);
            
            console.log('\n\nMATCH FOUND!');
            console.log('Private Key:', message.privateKey);
            console.log('Address:', message.address);
            console.log('Time elapsed:', ((Date.now() - progress.startTime)/1000/60).toFixed(2), 'minutes');
            console.log('Total keys checked:', progress.totalKeys);
            
            // Save found key
            saveFoundKey(message.privateKey, message.address);
            
            // Remove progress file on success
            try {
                fs.unlinkSync(progressFile);
            } catch (e) {
                console.error("Error removing progress file:", e.message);
            }
            
            process.exit(0);
        } else {
            progress.totalKeys += message.count || 1;
            progress.currentKey = message.current || progress.currentKey;
        }
    });
} else {
    const [start, end] = keySpace.split(":");
    let current = BigInt(progress.currentKey);
    const endBigInt = BigInt(end);
    
    if (random) {
        while (true) {
            const privateKey = getRandomHexInRange(start, end);
            const address = privateKeyToAddress(privateKey);
            
            if (address && targetAddresses.includes(address)) {
                process.send({
                    found: true,
                    privateKey,
                    address
                });
                break;
            }
            
            if (Math.random() < 0.01) {
                process.send({
                    current: privateKey
                });
            }
        }
    } else {
        // Sequential search implementation
        while (current <= endBigInt) {
            const privateKey = current.toString(16).padStart(64, '0');
            const address = privateKeyToAddress(privateKey);
            
            if (address && targetAddresses.includes(address)) {
                process.send({
                    found: true,
                    privateKey,
                    address
                });
                break;
            }
            
            current++;
            
            if (current % 1000n === 0n) {
                process.send({
                    count: 1000,
                    current: privateKey
                });
            }
        }
    }
}
