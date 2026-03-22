/**
 * GTD Migration Script
 * 
 * Creates the full project structure and populates tasks from the sandbox/Tasks file.
 * 
 * Usage:
 *   TODOIST_TOKEN=your_token node scripts/migrate.js
 * 
 * Set DRY_RUN=1 to preview without making changes:
 *   DRY_RUN=1 TODOIST_TOKEN=your_token node scripts/migrate.js
 */

const TOKEN = process.env.TODOIST_TOKEN;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!TOKEN) {
    console.error('ERROR: Set TODOIST_TOKEN environment variable first.');
    process.exit(1);
}

const BASE = 'https://api.todoist.com/api/v1';

async function api(method, path, body) {
    if (DRY_RUN && method !== 'GET') {
        console.log(`[DRY RUN] ${method} ${path}`, body ? JSON.stringify(body) : '');
        return { id: `dry-${Math.random().toString(36).slice(2)}`, name: body?.name ?? '' };
    }
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

async function getProjects() {
    const page = await api('GET', '/projects?limit=200');
    return page.results ?? [];
}

async function createProject(name, parentId, color) {
    console.log(`  📁 Creating project: ${name}`);
    return api('POST', '/projects', {
        name,
        ...(parentId ? { parent_id: parentId } : {}),
        ...(color ? { color } : {}),
    });
}

async function createTask(content, projectId, opts = {}) {
    console.log(`    ✅ Creating task: ${content}`);
    return api('POST', '/tasks', {
        content,
        project_id: projectId,
        ...(opts.labels ? { labels: opts.labels } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.due_string ? { due_string: opts.due_string } : {}),
        ...(opts.priority ? { priority: opts.priority } : {}),
        ...(opts.parent_id ? { parent_id: opts.parent_id } : {}),
    });
}

async function deleteTask(id) {
    return api('DELETE', `/tasks/${id}`);
}

// ---------------------------------------------------------------------------
// Tasks to clean up (template junk + test tasks)
// ---------------------------------------------------------------------------
const TASKS_TO_DELETE = [
    // Project Tracker template tasks
    '6WwJx68C2wrQxV7x', '6WwJx68qPqcGjmCx', '6WwJx67PxPq4M77Q', '6WwJx68fvCX3JmrQ',
    '6WwJx683MCJ3mw9Q', '6WwJx68mv88jhCjQ', '6WwJx68Wh7J7gP8x', '6WwJx68pghxp3wwx',
    '6WwJx67cGGx6CGHx', '6WwJx69jhJG6xr6x', '6WwJx68QF7xJ3Cgx', '6WwJx675QmmRXRPQ',
    '6WwJx698frvm68Xx', '6WwJx69JVPpW5jcQ', '6WwJx69X9mm426CQ', '6WwJx69qGmRqFV8x',
    '6WwJx67m6MqFG7cx', '6WwJx68FWphcRRrQ', '6WwJx67Fx3689Hpx', '6WwJx68w2PpPV3qQ',
    '6WwJx675J9g422gx', '6WwJx694jp3gR4wx', '6WwJx6Jr559JHphx', '6WwJx6Jx2hw7626x',
    '6WwJx6JvW7J9gGPx', '6WwJx68Mr6XfFGrx', '6WwJx67FJjJ4R52x', '6WwJx699hxrwV4Fx',
    '6WwJx68fGGMqvqhx', '6WwJx68G3Qfx939x', '6WwJx6942jg2xf4x', '6WwJx69HhPvGXMQx',
    '6WwJx683rJr6MPHx', '6WwJx68QgmFpxqJx', '6WwJx69HCPRPFvXx', '6WwJx67cGGx6CGHx',
    // Test tasks in Active
    '6WwJwVXr99mHhXgX', '6WwJwW2cf3C3WQvX', '6WwJwWGwF9rxf7H5', '6WwJwXVPRxx8v425',
    // Inbox junk
    '6g75Hjj23P9WJC6H', '6g75vm4FxC4QwR7q',
    // Lists duplicates/test
    '6g75cFQp3PPmgc7R', '6g75frRX3WGC5Gq5', '6g75f6JjJg6MG7PQ',
];

// ---------------------------------------------------------------------------
// New project structure
// ---------------------------------------------------------------------------
async function main() {
    console.log(DRY_RUN ? '\n🔍 DRY RUN — no changes will be made\n' : '\n🚀 Starting GTD migration\n');

    // ── Step 1: Delete junk tasks ──────────────────────────────────────────
    console.log('Step 1: Deleting template/test tasks…');
    for (const id of TASKS_TO_DELETE) {
        try {
            await deleteTask(id);
            console.log(`  🗑  Deleted ${id}`);
        } catch (e) {
            console.warn(`  ⚠️  Could not delete ${id}: ${e.message}`);
        }
    }

    // ── Step 2: Create top-level projects ─────────────────────────────────
    console.log('\nStep 2: Creating project structure…');

    const pPersonal    = await createProject('🧍 Personal',       null, 'blue');
    const pHome        = await createProject('🏠 Home',           null, 'green');
    const pVehicle     = await createProject('🚗 Vehicle',        null, 'orange');
    const pDigital     = await createProject('💻 Digital & Tech', null, 'grape');
    const pProfessional= await createProject('💼 Professional',   null, 'sky_blue');
    const pSomeday     = await createProject('💭 Someday/Maybe',  null, 'charcoal');
    const pWaiting     = await createProject('⏳ Waiting For',    null, 'lavender');

    // ── Sub-projects under Personal ───────────────────────────────────────
    const pHealth      = await createProject('Health',   pPersonal.id);
    const pFinance     = await createProject('Finance',  pPersonal.id);
    const pFamily      = await createProject('Family',   pPersonal.id);

    // ── Sub-projects under Home ───────────────────────────────────────────
    const pRepairs     = await createProject('Repairs & Maintenance', pHome.id);
    const pWorkshop    = await createProject('Workshop',              pHome.id);
    const pGarden      = await createProject('Garden & Exterior',     pHome.id);
    const pHomePurch   = await createProject('Home Purchases',        pHome.id);

    // ── Sub-projects under Vehicle ────────────────────────────────────────
    const pRAV4        = await createProject('RAV4', pVehicle.id);

    // ── Sub-projects under Someday ────────────────────────────────────────
    const pSHomeideas  = await createProject('Home Ideas',      pSomeday.id);
    const pSGear       = await createProject('Gear & Equipment',pSomeday.id);
    const pSLearning   = await createProject('Learning',        pSomeday.id);

    // ── Step 3: Populate tasks ─────────────────────────────────────────────
    console.log('\nStep 3: Creating tasks…');

    // ── Inbox / unprocessed ───────────────────────────────────────────────
    console.log('\n  [Inbox — needs processing]');
    await createTask('Book appointment re: toe issue', pHealth.id, { labels: ['errand'] });
    await createTask('Investigate vacuum system options for workshop', pWorkshop.id, { labels: ['investigate'] });
    await createTask('Measure workshop for curtains', pWorkshop.id, { labels: ['handiwork'] });

    // ── Health ─────────────────────────────────────────────────────────────
    console.log('\n  [Health]');
    await createTask('Make Physio Appointment', pHealth.id, {
        labels: ['errand'],
        description: 'Extra: (450) 510-9474 | Ergo: (450) 218-2214 | St-Lazare: 450-319-6022',
    });

    // ── Finance ────────────────────────────────────────────────────────────
    console.log('\n  [Finance]');
    await createTask('File Taxes 2025', pFinance.id, { labels: ['office'], priority: 4 });
    await createTask('Schedule City Taxes Payment 2026', pFinance.id, { labels: ['office'] });
    await createTask('Configure Assist-Identite (Credit Verification)', pFinance.id, {
        labels: ['office'],
        description: 'https://bnra.assistidentite.com/fr/home',
    });
    await createTask('Investigate Death Instructions / Will (QC)', pFinance.id, { labels: ['office'] });
    await createTask('Invalidity Certificate — determine next step', pFinance.id, { labels: ['office'] });
    await createTask('Investigate investment allocation (TFSA/RRSP)', pFinance.id, { labels: ['investigate'] });

    // ── Home — Repairs & Maintenance ──────────────────────────────────────
    console.log('\n  [Repairs & Maintenance]');
    await createTask('Analyse home inspection report — flag action items', pRepairs.id, { labels: ['office'], priority: 3 });
    await createTask('Investigate house cracking', pRepairs.id, { labels: ['investigate'] });
    await createTask('Repair gutters — fill and cover hole with spray', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Install CO/Fire alarms', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Fly screen repair', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Install shower head tube', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Investigate stairs lip — determine if trip hazard', pRepairs.id, { labels: ['investigate'] });
    await createTask('Repair workshop wall — cut and install trims', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Clean paint main floor', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Caulking — investigate, purchase, and caulk home', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Sofa bed — fix attachments', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Repair bench (Gilles)', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Stain children bench', pRepairs.id, { labels: ['handiwork'] });
    await createTask('Stain kitchen table', pRepairs.id, { labels: ['handiwork'] });

    // ── Home — Workshop ───────────────────────────────────────────────────
    console.log('\n  [Workshop]');
    await createTask('Organize workshop', pWorkshop.id, { labels: ['home'] });
    await createTask('Purchase workshop light', pWorkshop.id, { labels: ['errand'] });
    await createTask('Design and build workbench', pWorkshop.id, { labels: ['handiwork'] });

    // ── Home — Garden & Exterior ──────────────────────────────────────────
    console.log('\n  [Garden & Exterior]');
    await createTask('Cleanup waterways backyard', pGarden.id, { labels: ['handiwork'] });
    await createTask('Sac compost — purchase', pGarden.id, { labels: ['errand'] });
    await createTask('Compost leaves', pGarden.id, { labels: ['home'] });
    await createTask('Remove tree branches', pGarden.id, { labels: ['handiwork'] });
    await createTask('Remove tree stump', pGarden.id, { labels: ['handiwork'] });
    await createTask('Driveway trees cleanup', pGarden.id, { labels: ['home'] });
    await createTask('Driveway rocks', pGarden.id, { labels: ['home'] });

    // ── Home — Purchases ──────────────────────────────────────────────────
    console.log('\n  [Home Purchases]');
    await createTask('Purchase workshop light', pHomePurch.id, { labels: ['errand'] });

    // ── RAV4 ──────────────────────────────────────────────────────────────
    console.log('\n  [Vehicle]');
    await createTask('Call Radiateur Willard re: AC repair', pRAV4.id, {
        labels: ['comm-work'],
        description: 'http://www.radiateurswillard.com/ | 450-455-7963',
    });
    await createTask('Investigate brake light repair', pRAV4.id, { labels: ['investigate'] });
    await createTask('Summer tire change', pRAV4.id, {
        labels: ['errand'],
        description: '(450) 451-5502',
        due_string: 'May 2026',
    });

    // ── Digital & Tech ────────────────────────────────────────────────────
    console.log('\n  [Digital & Tech]');
    await createTask('Organize office', pDigital.id, { labels: ['office'] });
    await createTask('Clean PC case', pDigital.id, { labels: ['home'] });
    await createTask('Investigate photo backup solution', pDigital.id, { labels: ['investigate'] });
    await createTask('Investigate efficiency-focused phone setup', pDigital.id, { labels: ['investigate'] });
    await createTask('Investigate internet upgrade options', pDigital.id, { labels: ['investigate'] });
    await createTask('Process OCT Archives', pDigital.id, { labels: ['office'] });
    await createTask('Process OCT Tickler', pDigital.id, { labels: ['office'] });

    // ── Family ────────────────────────────────────────────────────────────
    console.log('\n  [Family]');
    await createTask('Shop kids playground options', pFamily.id, { labels: ['investigate'] });
    await createTask('Sharpen knives', pFamily.id, { labels: ['home'] });

    // ── Someday — Home Ideas ──────────────────────────────────────────────
    console.log('\n  [Someday/Maybe — Home Ideas]');
    const somehome = [
        'Clean interior water ducts', 'Gift card rack', 'House door seals',
        'Trailer level adapter', 'Fix water hardness', 'Toybox table basement',
        'Water hardness pipe cleaning', 'Flowerbeds', 'Exterior LED lighting',
        'Water pressure investigation', 'House outside electrical lighting',
        'Investigate ampoule beatrice', 'Verify trees health',
        'Mouse infiltration investigation', 'Permethrin', 'Water pump breaker',
        'Make standup desk stand', 'Office ceiling scratch', 'Water detector basement',
        'Workshop ceiling', 'Replace desk', 'Locker section entrance',
        'Backyard landscaping', 'Patio restain', 'Attic check',
        'Air exchanger', 'Family room TV stand', 'Family room paint',
        'Master bedroom LED lighting investigate', 'Main floor light fixture investigate',
        'Compost strategy', 'Garden planning', 'Gym upgrade', 'Move entrance heater',
        'Repair stairway walls', 'Smart heating investigation',
        'Dehumidifier autodrain investigate',
    ];
    for (const t of somehome) {
        await createTask(t, pSHomeideas.id);
    }

    // ── Someday — Gear & Equipment ────────────────────────────────────────
    console.log('\n  [Someday/Maybe — Gear & Equipment]');
    const gear = [
        'Compressor', 'Clamps', 'Compressed air tools',
        'Charging table living room', 'Pouf living room', 'Living room table',
        'Marmitte', 'Electric nail gun(s)', '20v compressor + air guns',
        'Dice trays', 'Escape Tales (board game)',
    ];
    for (const t of gear) {
        await createTask(t, pSGear.id);
    }

    // ── Someday — Learning ────────────────────────────────────────────────
    console.log('\n  [Someday/Maybe — Learning]');
    const books = [
        { title: 'Read: Modern Operating Systems (Tanenbaum)', desc: 'https://csc-knu.github.io/sys-prog/books/Andrew%20S.%20Tanenbaum%20-%20Modern%20Operating%20Systems.pdf' },
        { title: 'Read: Operating System Concepts (Silberschatz)', desc: 'https://os.ecci.ucr.ac.cr/slides/Abraham-Silberschatz-Operating-System-Concepts-10th-2018.pdf' },
        { title: 'Read: C# 10 in a Nutshell', desc: 'https://dl.ebooksworld.ir/books/CSharp.10.in.a.Nutshell.Joseph.Albahari.OReilly.9781098121952.EBooksWorld.ir.pdf' },
        { title: 'Study: Terraform', desc: '' },
        { title: 'Study: Kubernetes', desc: '' },
        { title: 'Study: Jinja', desc: '' },
    ];
    for (const b of books) {
        await createTask(b.title, pSLearning.id, b.desc ? { description: b.desc } : {});
    }

    console.log('\n✅ Migration complete!');
    console.log('\nNext steps:');
    console.log('  1. Add the Todoist Labels in Settings: @errand @handiwork @home @office @investigate @comm-work @comm-flex @agenda-marie @professional');
    console.log('  2. Review and delete old projects: Active, Project Tracker, Lists (if desired)');
    console.log('  3. Set up Weekly Review recurring task in Reminders');
    console.log('  4. Refresh the VS Code extension');
}

main().catch(err => {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
});
