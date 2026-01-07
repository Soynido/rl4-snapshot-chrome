#!/usr/bin/env python3
"""
Simple icon generator using base64 PNG data
Creates 3 PNG icons: 16x16, 48x48, 128x128
"""

import base64
import struct

def create_simple_png(width, height, bg_color=(84, 54, 218), text_color=(255, 255, 255)):
    """Create a simple PNG with RL4 text"""
    # PNG signature
    png = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr_crc = 0x9A768C92  # Simplified
    ihdr_chunk = struct.pack('>I', 13) + b'IHDR' + ihdr_data + struct.pack('>I', ihdr_crc)
    png += ihdr_chunk
    
    # Simple approach: create minimal valid PNG
    # For simplicity, we'll create a very basic PNG structure
    # This is a placeholder - in production, use PIL or proper PNG library
    
    return png

# Instead, let's create SVG files that can be converted
def create_svg_icon(size, add_snapshot=False):
    """Create SVG icon"""
    svg = f'''<svg width="{size}" height="{size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="{size}" height="{size}" fill="#5436DA"/>
  <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="{size//2}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="central">RL4</text>
'''
    if add_snapshot and size >= 128:
        svg += f'''  <rect x="{size-40}" y="{size-40}" width="32" height="32" fill="none" stroke="white" stroke-width="2"/>
  <line x1="{size-36}" y1="{size-30}" x2="{size-8}" y2="{size-30}" stroke="white" stroke-width="1"/>
  <line x1="{size-36}" y1="{size-24}" x2="{size-8}" y2="{size-24}" stroke="white" stroke-width="1"/>
  <line x1="{size-36}" y1="{size-18}" x2="{size-8}" y2="{size-18}" stroke="white" stroke-width="1"/>
  <circle cx="{size-24}" cy="{size-52}" r="8" fill="none" stroke="white" stroke-width="2"/>
  <polygon points="{size-24},{size-60} {size-28},{size-56} {size-20},{size-56}" fill="white"/>
'''
    svg += '</svg>'
    return svg

# Create SVG files
for size, add_icon in [(16, False), (48, False), (128, True)]:
    svg_content = create_svg_icon(size, add_icon)
    with open(f'icon{size}.svg', 'w') as f:
        f.write(svg_content)

print("SVG icons created. Converting to PNG...")

