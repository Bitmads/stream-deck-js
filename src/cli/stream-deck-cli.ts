#!/usr/bin/env node

import open from "open"
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
const { keyboard, Key, mouse, left, right, up, down, screen } = require("@nut-tree/nut-js");

yargs(hideBin(process.argv))
    .scriptName("strd")
    .usage('$0 <cmd> [args]')
    .command('open [target]', 'Opens URL in the default browser', (yargs: { positional: (arg0: string, arg1: { type: string; default: string; describe: string; }) => void; }) => {
        yargs.positional('target', {
            type: 'string',
            default: 'https://bitmads.com',
            describe: 'The target to open'
        })
    }, async function (argv: {target:string}) {
        console.log('Opening', argv.target)
        await open(argv.target);

    })

    .command('press [keys]', 'Send the keys in the parameter', (yargs: { positional: (arg0: string, arg1: { type: string; default: string; describe: string; }) => void; }) => {
        yargs.positional('keys', {
            type: 'string',
            default: '',
            describe: 'The keys to press'
        })
    }, async function (argv: {keys:string}) {
        console.log('Pressing keys:', argv.keys)
        const steps = argv.keys.split(',');
        for(const sk in steps){
            const step = steps[sk];
            if(step.match(/^\+/i)){
                const keyName = step.replace(/^\+/,'');
                await keyboard.pressKey(Key[keyName]);
            }else
            if(step.match(/^\-/i)){
                const keyName = step.replace(/^\-/,'');
                await keyboard.releaseKey(Key[keyName]);
            }
        }
        /*await keyboard.pressKey(Key.LeftSuper);
        await keyboard.pressKey(Key.Space);
        await keyboard.releaseKey(Key.Space);
        await keyboard.releaseKey(Key.LeftSuper);*/

    })
    .help()
    .argv




