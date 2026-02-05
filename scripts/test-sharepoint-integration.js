#!/usr/bin/env node

/**
 * Test script for SharePoint Lists API integration
 * This script tests the new functionality for accessing hidden VTT files
 */

import { fetchVideoTranscript } from '../lib/ms-graph.js';

async function testSharePointIntegration() {
    console.log('🧪 Testing SharePoint Lists API Integration...');
    
    // Test with a sample SharePoint-hosted recording
    // You would need to replace these with actual values from your environment
    const testAccessToken = process.env.AZURE_ACCESS_TOKEN || 'YOUR_ACCESS_TOKEN_HERE';
    const testDriveItemId = 'YOUR_DRIVE_ITEM_ID';
    const testResourcePath = '/drives/YOUR_DRIVE_ID/items/YOUR_ITEM_ID';
    
    if (testAccessToken === 'YOUR_ACCESS_TOKEN_HERE') {
        console.log('❌ Please set AZURE_ACCESS_TOKEN environment variable with a valid Graph API token');
        console.log('💡 You can get this by authenticating with the app first');
        return;
    }
    
    try {
        console.log(`📡 Testing fetchVideoTranscript with:`);
        console.log(`   - Drive Item ID: ${testDriveItemId}`);
        console.log(`   - Resource Path: ${testResourcePath}`);
        
        const vttContent = await fetchVideoTranscript(testAccessToken, testDriveItemId, testResourcePath);
        
        if (vttContent) {
            console.log('✅ SUCCESS! Found VTT content:');
            console.log(`   - Content length: ${vttContent.length} characters`);
            console.log(`   - First 200 chars: ${vttContent.substring(0, 200)}...`);
            
            // Validate VTT format
            const lines = vttContent.split('\n');
            const hasWebVttHeader = lines[0]?.includes('WEBVTT');
            const hasCues = lines.some(line => line.includes('-->'));
            
            console.log(`   - Has WEBVTT header: ${hasWebVttHeader}`);
            console.log(`   - Has time cues: ${hasCues}`);
            
            if (hasWebVttHeader && hasCues) {
                console.log('🎉 VTT content appears to be valid!');
            } else {
                console.log('⚠️  VTT content may not be properly formatted');
            }
        } else {
            console.log('❌ No VTT content found');
        }
        
    } catch (error) {
        console.error('💥 Test failed with error:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

// Run the test
testSharePointIntegration();
