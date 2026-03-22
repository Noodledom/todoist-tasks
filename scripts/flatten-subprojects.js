#!/usr/bin/env node
/**
 * Flattens sub-projects into parent tasks.
 * For each sub-project:
 *   1. Create a parent task in the area project with the sub-project's name
 *   2. Move all tasks from the sub-project under that parent task
 *   3. Delete the sub-project
 */

const TOKEN = process.env.TODOIST_TOKEN;
if (!TOKEN) { console.error('Set TODOIST_TOKEN'); process.exit(1); }

const BASE = 'https://api.todoist.com/api/v1';

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) { return null; }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function getAllPages(path) {
    const results = [];
    let cursor = null;
    const sep = path.includes('?') ? '&' : '?';
    do {
        const url = `${BASE}${path}${sep}limit=200${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${TOKEN}` } });
        if (!res.ok) { throw new Error(`GET ${path} → ${res.status}`); }
        const page = await res.json();
        results.push(...page.results);
        cursor = page.next_cursor;
    } while (cursor);
    return results;
}

const SUBPROJECTS = [
    // 💻 Digital & Tech
    { projectId: '6g7h97wW3vxq8RjX', name: 'Internet Upgrade',                  areaProjectId: '6g7h6MMR26Q8rVVp' },
    { projectId: '6g7h982H8fX625m2', name: 'Organize Office',                    areaProjectId: '6g7h6MMR26Q8rVVp' },
    { projectId: '6g7h97rXg5GpGFG4', name: 'Photo Backup Solution',              areaProjectId: '6g7h6MMR26Q8rVVp' },
    // Health
    { projectId: '6g7h9892mGwVp8GW', name: 'Toe Issue',                          areaProjectId: '6g7h6Mj5c6wGqmxW' },
    // Finance
    { projectId: '6g7h95qPhQm4776v', name: 'File Taxes 2025',                    areaProjectId: '6g7h6Mp7pr7jmQH9' },
    { projectId: '6g7h95rRm799jpC6', name: 'Invalidity Certificate',             areaProjectId: '6g7h6Mp7pr7jmQH9' },
    { projectId: '6g7h969J255MqwfF', name: 'Investment Allocation (TFSA/RRSP)',  areaProjectId: '6g7h6Mp7pr7jmQH9' },
    { projectId: '6g7h964r9Qx8fM75', name: 'Will & Death Instructions',          areaProjectId: '6g7h6Mp7pr7jmQH9' },
    // Family
    { projectId: '6g7h98GJ9fcHH69w', name: 'Kids Playground',                    areaProjectId: '6g7h6Mr6vHFCPHF7' },
    // Repairs & Maintenance
    { projectId: '6g7h96XMpp6XhM4C', name: 'Caulking Project',                   areaProjectId: '6g7h6MxFq2FqHC47' },
    { projectId: '6g7h96gWq2Wh4rC3', name: 'Gutter Repair',                      areaProjectId: '6g7h6MxFq2FqHC47' },
    { projectId: '6g7h96VhW4fwJPQw', name: 'House Cracking Investigation',       areaProjectId: '6g7h6MxFq2FqHC47' },
    { projectId: '6g7h96jmM2xJ3grF', name: 'Workshop Wall Repair',               areaProjectId: '6g7h6MxFq2FqHC47' },
    // Garden & Exterior
    { projectId: '6g7h97XjRj6GGm36', name: 'Cleanup Waterways',                  areaProjectId: '6g7h6MxVJ5pjg7qj' },
    { projectId: '6g7h97gPcVxFpw69', name: 'Remove Tree Stump',                  areaProjectId: '6g7h6MxVJ5pjg7qj' },
    // Workshop
    { projectId: '6g7h96xhqMFJ3MRX', name: 'Design & Build Workbench',           areaProjectId: '6g7h6P2xcmM4pR54' },
    { projectId: '6g7h975MF54c8h4g', name: 'Organize Workshop',                  areaProjectId: '6g7h6P2xcmM4pR54' },
    { projectId: '6g7h9796jJfWWQhw', name: 'Vacuum System',                      areaProjectId: '6g7h6P2xcmM4pR54' },
    // RAV4
    { projectId: '6g7h97Jg33gHwRQv', name: 'AC Repair',                          areaProjectId: '6g7h6P64W2PmGx24' },
    { projectId: '6g7h97FG5849h59R', name: 'Brake Light Repair',                 areaProjectId: '6g7h6P64W2PmGx24' },
];

async function main() {
    for (const sp of SUBPROJECTS) {
        console.log(`\n── ${sp.name} ──`);

        // 1. Get all tasks currently in this sub-project
        const tasks = await getAllPages(`/tasks?project_id=${sp.projectId}`);
        console.log(`   Found ${tasks.length} task(s)`);

        // 2. Create the parent task in the area project
        process.stdout.write(`   Creating parent task "${sp.name}"... `);
        const parentTask = await api('POST', '/tasks', {
            content: sp.name,
            project_id: sp.areaProjectId,
        });
        console.log(`✅ (id: ${parentTask.id})`);

        // 3. Move each existing task under the new parent task
        for (const task of tasks) {
            process.stdout.write(`   Moving "${task.content}"... `);
            await api('POST', `/tasks/${task.id}/move`, {
                project_id: sp.areaProjectId,
                parent_id: parentTask.id,
            });
            console.log('✅');
        }

        // 4. Delete the now-empty sub-project
        process.stdout.write(`   Deleting sub-project "${sp.name}"... `);
        await api('DELETE', `/projects/${sp.projectId}`);
        console.log('✅');
    }

    console.log('\n�� Done! All sub-projects flattened into parent tasks.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
