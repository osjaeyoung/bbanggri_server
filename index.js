import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'fs/promises';
import admin from 'firebase-admin';

const jsonFormat = { "Content-Type": "application/json" };


dotenv.config();

// Supabase 설정
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// firebase 설정
const jsonString = await readFile('./firebaseAccount.json', 'utf-8');
const firebaseAccount = JSON.parse(jsonString);

admin.initializeApp({
    credential: admin.credential.cert(firebaseAccount),
});

// 연결된 클라이언트 저장
// 클라이언트 맵 구조
//  key                     value
// roomID (DB req_id) - [wsMe, wsOther]
// WebSocket Value => 웹 소켓과 uuid를 갖는다.

const roomClients = new Map(); // ✅ roomId → Set<WebSocket>

const host = process.env.HOST;
const port = process.env.PORT;

const wss = new WebSocketServer({ host: host, port: port });
console.log(`🚀 WebSocket Server running on ws://${host}:${port}`);

wss.on('connection', (ws) => {
    console.log('🟢 New client connected');

    ws.on('message', async (raw) => {
        try {

            const msg = JSON.parse(raw);

            if (msg.type === 'create_room') {
                const { roomId, uuidMe, uuidOther } = msg;

                // 서버 쪽 저장소에 등록, 만약 클라이언트 방이 생성되어있지 않을 경우, 생성
                if (!roomClients.has(roomId)) {
                    roomClients.set(roomId, new Set());
                    console.log(`📌 create room ${roomId} success`);
                }

                ws.uuid = uuidMe;

                roomClients.get(roomId).add(ws);
                console.log(`🟢 ${uuidMe} joined in ${roomId}`);

                const msgMe = await getMessage(roomId, uuidMe);
                const msgOther = await getMessage(roomId, uuidOther);

                if (isExistNotReadMsg(msgMe)) {
                    // 읽지 않은 메시지가 있을 경우
                    // 읽음 처리 한다.
                    const notReadMsg = [];

                    for (let i = 0; i < msgMe.length; i++) {

                        if (msgMe[i].isRead == false) {
                            msgMe[i].isRead = true;
                            notReadMsg.push(msgMe[i]);
                        }
                        msgOther[i].isRead = true;
                    }

                    await updateMessage(msgMe, uuidMe, roomId);
                    await updateMessage(msgOther, uuidOther, roomId);
                    ws.send(JSON.stringify({
                        payload: {
                            type: 'notReadMsg',
                            notReadMsg
                        }
                    }));
                }

                const okMessage = {
                    "type": "read_signal",
                    "roomId": roomId,
                    "msg": "ok",
                    "status": 100,
                };

                const room = roomClients.get(roomId);

                // 방 내부에서 자기를 제외한 다른 사람에게 브로드 캐스팅
                for (const client of room) {
                    if (client != ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ payload: okMessage }));
                    }
                }

                await createRoomNotification(roomId, uuidMe, uuidOther);

                return;
            } else if (msg.type === 'chat') {
                const { roomId, payload } = msg;
                const room = roomClients.get(roomId);
                // room은 Set 객체
                if (!room) {
                    console.log("🔴 error occured!, room doens't exist");
                    return;
                }; // 안전하게 탈출

                // 맵에서 가져온 room은 웹소켓 리스트 => [wsMe, wsOther]

                // payload 설계
                /*  "type": header
                    "roomId": room uuid
                        "payload": {
                          "msgId": Unix EpochTime
                          "uuidMe": uuid Me
                          "uuidOther": uuid Other
                          "msg": string or base64Encode,
                          "isRead": boolean,
                }*/
                /*
                // db에 저장되는 json 내용
                {
                    "msgId":1751606301000,
                    "source":"me",
                    "msg":"안녕하세요",
                    "isRead":true
                }
                */

                // 나의 메시지 레코드엔 me, 타인 메시지 레코드는 other로 삽입한다.
                // 메시지를 삽입할 때, 항상 2개의 레코드가 한쌍으로 업데이트 되어야 한다.

                const myJsonMsg = await getMessage(roomId, payload.uuidMe);
                // 내 레코드를 가져온다.

                const otherJsonMsg = await getMessage(roomId, payload.uuidOther);
                // 타인의 레코드를 가져온다.

                const msgToMe = {
                    "msgId": payload.msgId,
                    "source": "me",
                    "msg": payload.msg,
                    "isRead": false
                };

                const msgToOther = {
                    "msgId": payload.msgId,
                    "source": "other",
                    "msg": payload.msg,
                    "isRead": false
                }


                myJsonMsg.push(msgToMe);
                otherJsonMsg.push(msgToOther);
                // 채팅 기록을 추가한 뒤.


                await updateMessage(myJsonMsg, payload.uuidMe, roomId);
                await updateMessage(otherJsonMsg, payload.uuidOther, roomId);

                await updateLastMessage(payload.msg, payload.msgId, payload.uuidMe, roomId);
                await updateLastMessage(payload.msg, payload.msgId, payload.uuidOther, roomId);

                if (room.size == 1) {
                    // 자기 혼자밖에 없는 방 일때, pushMessage를 날린다.
                    const { data: token, error } = await supabase.from('user_fcm_token')
                        .select('token')
                        .eq('unique_id', payload.uuidOther)
                        .single();

                    if (error)
                        console.log(JSON.stringify(error));

                    sendPushMessage(msg, payload.msg, token.token);
                }
                else {
                    payload.source = "other";

                    // 방 내부에서 자기를 제외한 다른 사람에게 브로드 캐스팅
                    for (const client of room) {
                        if (client != ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ payload }));
                        }
                    }
                }
            }
            else if (msg.type === 'promise') {
                const { roomId, payload } = msg;
                const room = roomClients.get(roomId);
                // room은 Set 객체
                if (!room) {
                    console.log("🔴 error occured!, room doens't exist");
                    return;
                }; // 안전하게 탈출

                const myJsonMsg = await getMessage(roomId, payload.uuidMe);
                // 내 레코드를 가져온다.

                const otherJsonMsg = await getMessage(roomId, payload.uuidOther);
                // 타인의 레코드를 가져온다.

                const msgToMe = {
                    "msgId": payload.msgId,
                    "source": "promise",
                    "msg": payload.msg,
                    "isRead": false
                };

                const msgToOther = {
                    "msgId": payload.msgId,
                    "source": "promise",
                    "msg": payload.msg,
                    "isRead": false
                }


                myJsonMsg.push(msgToMe);
                otherJsonMsg.push(msgToOther);
                // 채팅 기록을 추가한 뒤.

                await updateMessage(myJsonMsg, payload.uuidMe, roomId);
                await updateMessage(otherJsonMsg, payload.uuidOther, roomId);

                await updateLastMessage(payload.msg, payload.msgId, payload.uuidMe, roomId);
                await updateLastMessage(payload.msg, payload.msgId, payload.uuidOther, roomId);

                if (room.size == 1) {
                    // 자기 혼자밖에 없는 방 일때, pushMessage를 날린다.
                    const { data: token, error } = await supabase.from('user_fcm_token')
                        .select('token')
                        .eq('unique_id', payload.uuidOther)
                        .single();

                    if (error)
                        console.log(JSON.stringify(error));

                    sendPushMessage(msg, payload.msg, token.token);
                }
                else {
                    payload.source = "promise";

                    // 방 내부에서 자기를 제외한 다른 사람에게 브로드 캐스팅
                    for (const client of room) {
                        if (client != ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ payload }));
                        }
                    }
                }

            }
            else if (msg.type === 'read_signal') {
                const { signal, status, roomId, uuidMe, uuidOther } = msg;
                const room = roomClients.get(roomId);

                if (status === 100) {
                    if (signal === 'ok') {

                        const okMessage = {
                            "type": "read_signal",
                            "roomId": roomId,
                            "msg": "ok",
                            "status": 100,
                        };

                        // 방 내부에서 자기를 제외한 다른 사람에게 브로드 캐스팅
                        for (const client of room) {
                            if (client != ws && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ payload: okMessage }));
                            }
                        }

                        // console.log(uuidMe);
                        const myJsonMsg = await getMessage(roomId, uuidMe);
                        // 내 레코드를 가져온다.

                        const otherJsonMsg = await getMessage(roomId, uuidOther);
                        // 타인의 레코드를 가져온다.

                        for (let i = 0; i < myJsonMsg.length; i++) {
                            myJsonMsg[i].isRead = true;
                            otherJsonMsg[i].isRead = true;
                        }

                        await updateMessage(myJsonMsg, uuidMe, roomId);
                        await updateMessage(otherJsonMsg, uuidOther, roomId);

                    }
                }

            }
            else if (msg.type === 'disconnect') {
                const { roomId, uuid } = msg;
                const room = roomClients.get(roomId);

                for (const client of room) {
                    if (uuid === client.uuid && client.readyState === WebSocket.OPEN) {
                        room.delete(client);
                        console.log(`🔴 ${uuid} disconnected in ${roomId}`);
                    }
                }
                if (room.size === 0) {
                    roomClients.delete(roomId);
                    console.log(`🔴 ${roomId} is empty, delete room...`);
                }
            }
        } catch (err) {
            console.error('❌ JSON parse error:', err);
        }
    });

    ws.on('close', () => {
        console.log('🔴 Client disconnected');
    });
});

async function createRoomNotification(roomId, uuidMe, uuidOther) {
    // 방이 최초로 만들어질 때 상대방에게 알림을 준다.
    const { data: room, error: roomError } = await supabase.from('chattings')
        .select('is_notified')
        .eq('room_id', roomId);

    if (roomError)
        console.log(`🔴 error occured!, while send create notification ${roomError}`);

    if (room[0].is_notified == false) {

        const { data: update, error: updateError } = await supabase.from('chattings')
            .update({ is_notified: true })
            .eq('room_id', roomId);

        if (updateError)
            console.log(`🔴 error occured!, update flag ${updateError}`);


        const { data: fcmToken, error } = await supabase.from('user_fcm_token')
            .select('token')
            .eq('unique_id', uuidOther)
            .single();

        if (error)
            console.log(JSON.stringify(error));

        const { data: other, error: otherInfoError } = await supabase.from('profiles')
            .select('name')
            .eq('unique_id', uuidOther)
            .single();

        if (otherInfoError)
            console.log(`🔴 error occured!, update flag ${otherInfoError}`);

        const alarmMsg = `${other.name}님이 대화를 요청했어요!`;

        const { data: alarm, error: alarmError } = await supabase.from('alarm')
            .insert({
                unique_id_to: uuidOther,
                unique_id_from: uuidMe,
                alarm_name: alarmMsg,
                room_id: roomId,
                is_read: false,
                alarm_time: Date.now()
            })
            .select()
            .single();

        if (alarmError) {
            console.log(`🔴 error occured!, insert alarm to other`);
            console.error(alarmError);
        }


        const pushMsg = {
            notification: {
                title: '빵그리앱',
                body: alarmMsg,
            },
            data: {
                type: "alarm",
                alarmName: alarm.alarm_name,
                isRead: alarm.is_read.toString(),
                alarmTime: alarm.alarm_time.toString()
            },
            token: fcmToken.token,
        };

        admin
            .messaging()
            .send(pushMsg)
            .then((response) => {
                console.log('✅ Successfully sent message:', response);
            })
            .catch((error) => {
                console.error('❌ FCM 전송 실패:', error.code, error.message, error.stack);
                // console.error('❌ Error sending message:', error);
            });

    }
}

function isExistNotReadMsg(msg) {

    for (let i = 0; i < msg.length; i++) {
        // 다른사람이 보낸 메시지를 내가 읽지 않았을 경우
        if (msg[i].isRead == false && msg[i].source == "other")
            return true;
    }

    return false;
}

async function updateLastMessage(lastMsg, lastTime, uuid, roomId) {

    const { data: myUpdate, error: myUpdateError } = await supabase.from('chattings')
        .update({
            last_msg: lastMsg,
            last_chat_time: lastTime,
        })
        .eq('unique_id_me', uuid)
        .eq('room_id', roomId);

    if (myUpdateError) {
        console.log("🔴 error occured!, while update last message");
        console.log(myUpdateError);
    }

}

async function updateMessage(msg, uuid, roomId) {

    let notReadCount = 0;

    for (let i = 0; i < msg.length; i++) {
        if (msg[i].isRead == false && msg[i].source == "other")
            notReadCount++;
    }

    const { data: myUpdate, error: myUpdateError } = await supabase.from('chattings')
        .update({
            message: JSON.stringify(msg),
            not_read_count: notReadCount
        })
        .eq('unique_id_me', uuid)
        .eq('room_id', roomId);

    if (myUpdateError) {
        console.log("🔴 error occured!, while update message");
        console.log(myUpdateError);
    }

}

async function getMessage(roomId, uuid) {

    const { data, error: myError } = await supabase.from('chattings')
        .select('message')
        .eq('room_id', roomId)
        .eq('unique_id_me', uuid)
        .single();

    if (myError) {
        console.log(`🔴 error occured!, while access ${uuid} record`);
        console.log(myError);
    }

    return JSON.parse(data.message);
}

/* 
    메시지 json 구조
    {
        notification:{
            title : this is title
            body : message
        }
        token : fcmToken
    }
*/


/*
"type": header
    "roomId": room uuid
        "payload": {
            "msgId": Unix EpochTime
            "uuidMe": uuid Me
            "uuidOther": uuid Other
            "msg": string or base64Encode,
            "isRead": boolean,
*/


async function sendPushMessage(data, body, fcmToken) {

    const { data: otherInfo, error } = await supabase.from('profiles')
        .select('*')
        .eq('unique_id', data.payload.uuidOther)
        .single();

    if (error)
        console.error('❌ Error sending message:', error);

    const { data: reqId, error: reqId_error } = await supabase.from("chattings")
        .select('req_id_fk')
        .eq('room_id', data.roomId);

    if (reqId_error)
        console.error('❌ Error sending message:', error);

    // 다른사람에게 읽지 않음을 알려야 하기 때문에 uuidOther의 not_read_count를 읽어온다.
    const { data: notReadCount, error: notReadCountError } = await supabase.from("chattings")
        .select('not_read_count')
        .eq('unique_id_me', data.payload.uuidOther)
        .eq('room_id', data.roomId)
        .single();

    // console.log(notReadCount);

    if (notReadCountError)
        console.error('❌ Error sending message:', error);


    const pushMsg = {
        notification: {
            title: '빵그리앱',
            body: body,
        },
        data: {
            type: "message",
            roomId: String(data.roomId),
            reqId: String(reqId[0].req_id_fk),
            lastmsg: String(body),
            chatTime: String(data.payload.msgId),
            uuidOther: String(data.payload.uuidMe),
            name: String(otherInfo.name ?? ''),
            cellphone: String(otherInfo.cellphone ?? ''),
            profileImg: String(otherInfo.profile_img ?? ''),
            location: String(otherInfo.location ?? ''),
            notReadCount: String(notReadCount.not_read_count ?? '0'),
        },
        token: fcmToken,
    };

    // console.log(pushMsg);

    admin
        .messaging()
        .send(pushMsg)
        .then((response) => {
            console.log('✅ Successfully sent message:', response);
        })
        .catch((error) => {
            console.error('❌ FCM 전송 실패:', error.code, error.message, error.stack);
            // console.error('❌ Error sending message:', error);
        });
}