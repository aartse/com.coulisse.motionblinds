// Support for MOTION Blinds by Coulisse, by Edwin Delsman

const Crypto = require('crypto');
const UDP = require('dgram');
const EventEmitter = require('events');

const MULTICAST_ADDRESS = '238.0.0.18';
const UDP_PORT_SEND     = 32100;
const UDP_PORT_RECEIVE  = 32101;

class MotionGateway {
    constructor(mdriver, mac) {
        this.motionDriver = mdriver;
        this.key = mdriver.key;
        this.mac = mac;
        this.gatewayAddress = null;
        this.accessToken = null;
        this.token = null;
        this.nrDevices = 0;
    }

    calculateAccessToken() {
        if (this.motionDriver.key != null && this.token != null) {
            const cipher = Crypto.createCipheriv('aes-128-ecb', this.motionDriver.key, null);
            let buff = Buffer.concat([cipher.update(this.token), cipher.final()]);
            let text = buff.toString('hex');
            let wasnotready = this.accessToken == null;
            this.accessToken = text.substring(0, 32).toUpperCase();
			this.motionDriver.log('Accesstoken set');
            if (wasnotready) 
                this.motionDriver.onReady(this.mac);
        } else if (this.accessToken != null) {
            this.accessToken = null;
			this.motionDriver.log('Accesstoken cleared');
            this.motionDriver.onNotReady(this.mac);
        }
    }

    setToken(newToken) {
        if (newToken == undefined)
            newToken = null;
        if (newToken != this.token) {
            this.token = newToken;
            this.calculateAccessToken();
        }
    }

    setAppKey(appKey) {
        if (appKey == undefined)
            appKey = null;
        if (appKey != this.key) {
            this.key = appKey;
            this.calculateAccessToken();
        }
    }

    setGatewayAddress(addr) {
        if (this.gatewayAddress != addr) {
            this.gatewayAddress = addr;
            return true;
        }
        return false;
    }

    isReady() {
        return this.accessToken != null;
    }
}

class MotionDeviceID {
    constructor(mac, deviceType) {
        this.mac = mac;
        this.deviceType = deviceType;
        this.registered = false;
    }
}

class MotionDevice {
    constructor(mac, deviceType, gateway) {
        this.id = new MotionDeviceID(mac, deviceType);
        this.gateway = gateway;
    }
}

/*
This driver provides access to the Motion Wifi Gateways that are in your local network.
Use the connect method to open communication with the gateways. The key provided can be retrieved from the Motion App: 
Quickly tap the 'Motion APP about' 5 times to get the key, it should have format of the following example: 74ae544c-d16e-4c

You can listen to the following events (though there should not be any imminent need):

'listening' The UDP socket is now listening
'error' An error occurred
'close' Cle UPD socket was closed
'connect' The Motion Gateway is being connected
'disconnect' The Motion Gateway is being disconnected
'ready' The accesstoken is calculated for the gateway with the given mac, so you can write to its devices and/or get device states.
'notReady' The accesstoken for the gateway with the given mac is no longer available (e.g. due to close or key reset)
'newDevice' the device with the given mac is added
'newDevices' One or more new device were detected

Furthermote you can listen to all the msgTypes that the gateway supports. 
This is the preferred way of interacting with the MotionGateway.
Refer to their API documentation for all the messages.

This class provides the required accessToken (once ready) and messageID() to create the requests.
Also, the gateway retreives the deviceList, so you can make use of it
The deviceList should be there when the ready state is set, but in theory the heartbeat can come first, 
so it is wise to listen for the incoming 'GetDeviceListAck' message instead.
*/
class MotionDriver extends EventEmitter {
    DeviceType = {
        Gateway: '02000001', 
        ChildGateway: '02000002', 
        Blind: '10000000', 
        TopDownBottomUp: '10000001', 
        DoubleRoller: '10000002'
    }
    
    BlindType = { // Blind type matching of the blind using the values provided by the MotionDriver
        RollerBlind: 1,
        VenetianBlind: 2,
        RomanBlind: 3,
        HoneycombBlind: 4,
        ShangriLaBlind: 5,
        RollerShutter: 6,
        RollerGate: 7,
        Awning: 8,
        TopDownBottomUp: 9,
        DayNightBlind: 10,
        DimmingBlind: 11,
        Curtain: 12,
        CurtainLeft: 13,
        CurtainRight: 14,
        DoubleRoller: 17,
        Switch: 43
    }
    
    Operation = { 
        Close_Down: 0,
        Open_Up: 1,
        Stop: 2,
        StatusQuery: 5
    }

    Position = { 
        Open_Up: 0,
        Close_Down: 100
    }

    Angle = { 
        Open: 0,
        Close: 180
    }

    LimitStatus = { 
        NoLimits: 0,
        TopLimit: 1,
        BottomLimit: 2,
        Limits: 3,
        Limit3: 4
    }
    
    VoltageMode = { 
        AC: 0,
        DC: 1
    }
    
    WirelessMode = { 
        UniDirection: 0,
        BiDirection: 1,
        BidirectionMech: 2,
        Others: 3
    }
    
    constructor(motionapp = null) { 
        super();
        this.app = motionapp; // using external reference somehow works better than Homey.app, which is undefined when this initialises?
        this.key = null;
        this.devices = new Map();
        this.logging = true;
        this.verbose = false;
        this.logHeartbeat = false;
        this.pollAgain = false;
        this.pollTimer = undefined;
        this.client = UDP.createSocket({ type: 'udp4', reuseAddr: true });
        this.client.on('listening', function() { this.onListening() }.bind(this));
        this.client.on('error', function(error) { this.onError(error) }.bind(this));
        this.client.on('message', function(msg, info) { this.onMessage(msg, info) }.bind(this));
        this.client.on('close', function() { this.onClose() }.bind(this));
        process.on('SIGTERM', function() { this.disconnect() }.bind(this));
    }

	log(msg) {
        if (this.logging)
            if (this.app != null && this.app != undefined)
                this.app.log(msg);
            else
                console.log(msg);
    }

    error(msg) {
        if (this.app != null && this.app != undefined)
            this.app.error(msg);
        else
            console.error(msg);
    }

    getMessageID() {
        return new Date().toISOString().replace(/[T\-\./:Z]/g, '');
    }

    setAppKey(appKey) {
        if (appKey == undefined)
            appKey = null;
        if (appKey != this.key) {
            this.key = appKey;
            for (let entry of this.devices.values()) 
                entry.gateway.setAppKey(appKey);
        }
    }

    getAccessToken(mac, deviceType) {
        let gateway = this.getGateway(mac, deviceType);
        if (gateway != undefined && gateway.isReady())
            return gateway.accessToken;
        for (let entry of this.devices.values())  // fallback: hope / assume all gateways share the same token, best guess is better than none
            if (entry.gateway.isReady()) 
                return entry.gateway.accessToken;        
        return undefined;
    }

    getAccessTokenByID(id) {
        return this.getAccessToken(id.mac, id.deviceType);
    }

    percentageClosedToPosition(perc) {
        let pos = Math.round(perc * this.Position.Close_Down);
        return Math.max(Math.min(pos, this.Position.Close_Down), this.Position.Open_Up);
    }

    percentageOpenToPosition(perc) {
        return this.Position.Close_Down - this.percentageClosedToPosition(perc);
    }

    positionToPercentageClosed(pos) {
        let perc = Math.round(pos) / this.Position.Close_Down;
        return Math.min(Math.max(perc, 0), 1);
    }

    positionToPercentageOpen(pos) {
        return 1 - this.positionToPercentageClosed(pos);
    }
    
    angleToPercentageTilt(angle) {
        let perc = Math.round(angle) / this.Angle.Close;
        return 1 - Math.min(Math.max(perc, 0), 1);
    }

    percentageTiltToAngle(perc) {
        let angle = Math.round(perc * this.Angle.Close);
        return this.Angle.Close - Math.max(Math.min(angle, this.Angle.Close), this.Angle.Open);
    }

    /** use mac to find getGateway by it's mac, or add one if the deviceType is for a gateway and it isn't found yet.
     * If mac is null or undefined, it returns undefined, otherwise it returns a MotionGateway (either new or existing)
     */
     getGateway(mac, deviceType) { 
        if (mac == undefined || mac == null)
            return undefined;
        let item = this.devices.get(mac);
        if ((deviceType == this.DeviceType.Gateway || deviceType == this.DeviceType.ChildGateway) && item == undefined) {
            item = new MotionDevice(mac, deviceType, new MotionGateway(this, mac));
            this.devices.set(mac, item);
        }
        if (item != undefined) 
            return item.gateway;
        return undefined;
    }

    registerDeviceType(msg) { 
        if (msg.mac != undefined && msg.mac != null && msg.data != undefined && msg.data != null && msg.data.type != undefined) {
            let item = this.devices.get(msg.mac);
            if (item != undefined && item.id.type != msg.data.type) {
                this.log('Registered type ' + msg.data.type + ' for ' + msg.mac);
                item.id.type = msg.data.type;
                if (msg.data.wirelessMode != undefined)
                    item.id.wirelessMode = msg.data.wirelessMode;
            }
        }
    }

    registerDevice(mac, register = true) { 
        let item = this.devices.get(mac);
        if (item != undefined && item.id.registered != register) {
            this.log((register ? 'Registered ' : 'Unregistered ') + mac);
            item.id.registered = register;
            return true;
        } 
        return false;
    }

    isRegisteredDevice(mac) { 
        let item = this.devices.get(mac);
        if (item != undefined) {
            return item.id.registered;
            return true;
        } 
        return false;
    }

    getDevices(type = undefined, filter = undefined) {
        let devices = [];
        for (let entry of this.devices.values()) 
            if ((type == entry.id.deviceType || 
                ((type == undefined || type == null) && 
                    entry.id.deviceType != this.DeviceType.Gateway && entry.id.deviceType != this.DeviceType.ChildGateway)) &&
                    (filter == undefined || filter(entry.id)))
                devices.push(entry.id);
        return devices;
    }

    onListening() {
            let address = this.client.address();
            this.log('Listening using ' + address.family + ' on ' + address.address + ":" + address.port + ' ' + (this.key == null ? ' without' : 'with') + ' key');
            this.client.setBroadcast(true);
            this.client.setMulticastTTL(128);
            this.client.addMembership(MULTICAST_ADDRESS);
            this.emit('listening');
    }

    onError(error) {
        this.error(error);
//        this.client.close(function () {
//            this.token = null;
//            this.accessToken = null;
//            this.deviceList = null;
//			this.gatewayAddress = null;
//            this.emit('error', error);
//        })
    }

    onReady(mac) {
        this.emit('ready', mac);
    }

    onNotReady(mac) {
        this.emit('notReady', mac);
    }

    onMessage(msg, info) {
        let message = JSON.parse(msg.toString());
        if (this.logHeartbeat || message.msgType != 'Heartbeat')
            this.log(this.verbose ? message : 'Received ' + message.msgType + ' from ' + info.address + ' for ' + message.mac + '-' + message.deviceType);
		if (message.mac != undefined && info != null && info != undefined && info.address != undefined && 
		     info.address != null && info.address != '0.0.0.0' && info.address != MULTICAST_ADDRESS) {
            let gateway = this.getGateway(message.mac, message.deviceType);
            if (gateway != undefined && gateway.setGatewayAddress(info.address))
                this.log('Gateway adress for mac ' + message.mac + ' set to ' + info.address);
        }
        if (message.msgType == 'Heartbeat')
            this.onHeartbeat(message, info);
        else if (message.msgType == 'GetDeviceListAck')
            this.onGetDeviceListAck(message, info);
        this.emit(message.msgType, message, info);
        this.registerDeviceType(message);
    }

    onClose() {
        this.emit('close');
    }

    onGetDeviceListAck(msg, info) {
        let gateway = this.getGateway(msg.mac, msg.deviceType);
        let added = false;
        gateway.setToken(msg.token); 
        if (msg.data != undefined) {
            gateway.nrDevices = msg.data.length - 1; // the first is the gateway itself, so count one less. Remember, so on heartbeat we can see devices added
            for (let device of msg.data) 
                if (this.devices.get(device.mac) == undefined) {
                    this.devices.set(device.mac, new MotionDevice(device.mac, device.deviceType, gateway));
                    added = true;
                    this.emit('newDevice', device.mac);
                }
        }
        if (added)
            this.emit('newDevices');
    }
    
    onHeartbeat(msg, info) {
        let gateway = this.getGateway(msg.mac, msg.deviceType);
        gateway.setToken(msg.token);
        if (gateway.nrDevices != msg.data.numberOfDevices) // if device count changed, get new list
            this.send({ "msgType": "GetDeviceList", "msgID": this.getMessageID() }) 
    }

    async connect() {
        let id = this.getMessageID();
        this.client.bind(UDP_PORT_RECEIVE, function() {
            this.send({ "msgType": "GetDeviceList", "msgID": id });
            this.emit('connect');
        }.bind(this))
    }

    async disconnect() {
        this.client.close(function () {
            this.token = null;
            this.accessToken = null;
            this.deviceList = null;
            this.gatewayAddress = null;
            this.emit('disconnect');
        }.bind(this))
    }

    /**
     * Returns true if device write/status commands can be sent. It is required to set the appKey in advance. 
     * Also, the token must be received from the gateway. Untill then only devicelist and heartbeat are possible.
     * @returns boolean if accesstoken is ready
     */
    isReady(mac) {
        let gateway = this.getGateway(mac, '02000001');
        return gateway != undefined && gateway.isReady();
    }

    /**
     * Poll all states of all devices. Subsequent calls within the minute will be postponed until the minute is over.
     * if the wirelessMode of the device is known to be bidirectional then ReadDevice is used, 
     * otherwise WriteDevice with operation StatusQuery is called instead.
     * @param registered: if true only devices that registered themselves are polled, otherwise all. 
     * if false, only unregistered devices are polled. if undefined, all devices are polled. 
     */
    async pollStates(registered = true) {
        this.log('pollStates ' + (registered == undefined ? 'all' : (registered ? 'registered' : 'unregistered')));
        if (this.pollTimer == undefined) {
            this.pollTimer = setTimeout(function() {
                this.log('PollTimer ends, pollAgain = ' + this.pollAgain);
                this.pollTimer = undefined;
                if (this.pollAgain) {
                    this.pollAgain = false;
                    this.pollStates();
                }
              }.bind(this), 60000);
            this.pollAgain = false;
            let pollcount = 0;
            for (let entry of this.devices.values()) 
                if (entry.id.deviceType != this.DeviceType.Gateway && entry.id.deviceType != this.DeviceType.ChildGateway && 
                    (registered == undefined || entry.id.registered == registered)) {
                        ++pollcount;
                        if (entry.id.wirelessMode == this.WirelessMode.BiDirection || entry.id.wirelessMode == this.WirelessMode.BidirectionMech) 
                        this.send({
                            "msgType": 'ReadDevice',
                            "mac": entry.id.mac,
                            "deviceType": entry.id.deviceType,
                            "accessToken": this.getAccessTokenByID(entry.id),
                            "msgID": this.getMessageID()
                        });
                    else
                        this.send({
                            "msgType": 'WriteDevice',
                            "mac": entry.id.mac,
                            "deviceType": entry.id.deviceType,
                            "accessToken": this.getAccessTokenByID(entry.id),
                            "msgID": this.getMessageID(),
                            "data": {
                                "operation": this.Operation.StatusQuery
                            }
                        });
                    }
            this.log('polled ' + pollcount + ' devices');
        } else {
            this.pollAgain = true;
            this.log('Nested poll postponed');
        }
    }

    async send(msg) {
        let message = JSON.stringify(msg);
        let gateway = this.getGateway(msg.mac, msg.deviceType);
		let addr = gateway == undefined || gateway.gatewayAddress == null ? MULTICAST_ADDRESS : gateway.gatewayAddress;
        this.log(this.verbose ? msg : 'Sending ' + msg.msgType + ' to ' + addr + ' for ' + msg.mac + '-' + msg.deviceType);
        this.client.send(message, UDP_PORT_SEND, addr, function (error) {
            if (error) {
                this.error(error);
                this.emit('error', error);
            } else {
                this.emit(message.msgType, message);
            }
        }.bind(this));
        this.emit(msg.msgType, msg);
    }
}

module.exports = MotionDriver;
