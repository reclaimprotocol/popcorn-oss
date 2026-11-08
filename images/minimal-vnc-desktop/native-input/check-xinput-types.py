#!/usr/bin/env python3
"""Check the real XInput device types, without modifying the display."""
import ctypes as c
import json
import os
import sys

x11 = c.CDLL('libX11.so.6')
xi = c.CDLL('libXi.so.6')
x11.XOpenDisplay.argtypes = [c.c_char_p]
x11.XOpenDisplay.restype = c.c_void_p
x11.XCloseDisplay.argtypes = [c.c_void_p]
x11.XGetAtomName.argtypes = [c.c_void_p, c.c_ulong]
x11.XGetAtomName.restype = c.c_void_p
x11.XFree.argtypes = [c.c_void_p]


class Device(c.Structure):
    _fields_ = [('id', c.c_ulong), ('type', c.c_ulong), ('name', c.c_char_p),
                ('use', c.c_int), ('num_classes', c.c_int), ('classes', c.c_void_p)]


xi.XListInputDevices.argtypes = [c.c_void_p, c.POINTER(c.c_int)]
xi.XListInputDevices.restype = c.POINTER(Device)
xi.XFreeDeviceList.argtypes = [c.POINTER(Device)]
display = x11.XOpenDisplay(os.environ.get('DISPLAY', ':1').encode())
if not display:
    raise SystemExit('Cannot open the test display')

count = c.c_int()
devices = xi.XListInputDevices(display, c.byref(count))
result = []
try:
    for device in devices[:count.value]:
        atom = x11.XGetAtomName(display, device.type) if device.type else None
        device_type = c.string_at(atom).decode() if atom else None
        if atom:
            x11.XFree(atom)
        result.append({'id': device.id, 'name': device.name.decode(), 'type': device_type})
finally:
    xi.XFreeDeviceList(devices)
    x11.XCloseDisplay(display)

expected = {'TigerVNC pointer': 'MOUSE', 'TigerVNC keyboard': 'KEYBOARD'}
valid = all(any(d['name'] == name and d['type'] == kind for d in result)
            for name, kind in expected.items())
print(json.dumps({'devices': result, 'nativeTypesCorrect': valid}, indent=2))
sys.exit(0 if valid else 1)
