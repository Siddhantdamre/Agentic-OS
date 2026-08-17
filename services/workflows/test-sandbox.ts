import { SandboxClient } from '@agent-infra/sandbox';

async function main() {
    const sandbox = new SandboxClient({
        environment: "http://127.0.0.1:8080"
    });
    
    console.log("Connected! Running code...");
    const result = await sandbox.code.executeCode({
        language: "python",
        code: `print("Hello from the sandbox!")\nimport math\nprint(math.pi)`
    });

    console.log("Result:", result);
}

main().catch(console.error);
