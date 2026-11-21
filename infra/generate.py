"""Generate native CloudFormation templates. No deployment framework required."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
dev_schedule_minutes = json.loads((root.parent / "config/dev/bots.json").read_text())["offlinePolicy"]["scheduleMinutes"]
if type(dev_schedule_minutes) is not int or not 1 <= dev_schedule_minutes <= 1440:
    raise ValueError("offlinePolicy.scheduleMinutes must be an integer between 1 and 1440")
dev_schedule = f"rate({dev_schedule_minutes} " + ("minute)" if dev_schedule_minutes == 1 else "minutes)")
ref = lambda name: {"Ref": name}
sub = lambda text: {"Fn::Sub": text}
arn = lambda name: {"Fn::GetAtt": [name, "Arn"]}
retain = {"DeletionPolicy": "Retain", "UpdateReplacePolicy": "Retain"}
storage = {
    "AWSTemplateFormatVersion": "2010-09-09",
    "Resources": {"Artifacts": {"Type": "AWS::S3::Bucket", **retain, "Properties": {
        "BucketEncryption": {"ServerSideEncryptionConfiguration": [{"ServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]},
        "PublicAccessBlockConfiguration": {"BlockPublicAcls": True, "BlockPublicPolicy": True, "IgnorePublicAcls": True, "RestrictPublicBuckets": True},
        "VersioningConfiguration": {"Status": "Enabled"},
    }}},
    "Outputs": {"ArtifactBucket": {"Value": ref("Artifacts")}},
}
storage['Resources']['ArtifactTransportPolicy'] = {"Type": "AWS::S3::BucketPolicy", "Properties": {
    "Bucket": ref("Artifacts"), "PolicyDocument": {"Version": "2012-10-17", "Statement": [{
        "Effect": "Deny", "Principal": "*", "Action": "s3:*",
        "Resource": [arn("Artifacts"), sub("${Artifacts.Arn}/*")],
        "Condition": {"Bool": {"aws:SecureTransport": "false"}},
    }]}}}
parameters = {"Environment": {"Type": "String", "AllowedValues": ["dev", "staging", "prod"], "Default": "dev"},
              "ArtifactBucket": {"Type": "String"}, "ArtifactKey": {"Type": "String"},
              "RankingPeriodDays": {"Type": "Number", "Default": 1, "MinValue": 1, "MaxValue": 31}}
resources = {
    "PlayerTable": {"Type": "AWS::DynamoDB::Table", **retain, "Properties": {
        "BillingMode": "PAY_PER_REQUEST", "AttributeDefinitions": [{"AttributeName": k, "AttributeType": "S"} for k in ["PK", "SK", "duePartition", "dueAt", "activityPartition", "lastActiveAt", "journeyPK", "journeySK"]],
        "KeySchema": [{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
        "GlobalSecondaryIndexes": [{"IndexName": "IncomingDue", "KeySchema": [{"AttributeName": "duePartition", "KeyType": "HASH"}, {"AttributeName": "dueAt", "KeyType": "RANGE"}], "Projection": {"ProjectionType": "INCLUDE", "NonKeyAttributes": ["playerId"]}},
            {"IndexName": "PlayerActivity", "KeySchema": [{"AttributeName": "activityPartition", "KeyType": "HASH"}, {"AttributeName": "lastActiveAt", "KeyType": "RANGE"}],
             "Projection": {"ProjectionType": "KEYS_ONLY"}},
            {"IndexName": "JourneyRead", "KeySchema": [{"AttributeName": "journeyPK", "KeyType": "HASH"}, {"AttributeName": "journeySK", "KeyType": "RANGE"}],
             "Projection": {"ProjectionType": "INCLUDE", "NonKeyAttributes": ["rankDistance"]}}],
        "StreamSpecification": {"StreamViewType": "NEW_AND_OLD_IMAGES"},
        "PointInTimeRecoverySpecification": {"PointInTimeRecoveryEnabled": True},
        "SSESpecification": {"SSEEnabled": True},
    }},
    "UserPool": {"Type": "AWS::Cognito::UserPool", **retain, "Properties": {
        "UserPoolName": sub("yalla-${Environment}-players"), "DeletionProtection": "ACTIVE",
        "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": True},
        "UsernameConfiguration": {"CaseSensitive": True},
        "AccountRecoverySetting": {"RecoveryMechanisms": [{"Name": "admin_only", "Priority": 1}]},
        "MfaConfiguration": "OFF",
    }},
    "UserPoolClient": {"Type": "AWS::Cognito::UserPoolClient", "Properties": {
        "UserPoolId": ref("UserPool"), "ClientName": sub("yalla-${Environment}-unity"), "GenerateSecret": False,
        "ExplicitAuthFlows": ["ALLOW_ADMIN_USER_PASSWORD_AUTH"], "PreventUserExistenceErrors": "ENABLED",
        "EnableTokenRevocation": True,
        # Cognito defaults: access/id 1 hour, refresh 30 days. Guest key can reauthenticate after expiry.
        "RefreshTokenRotation": {"Feature": "ENABLED", "RetryGracePeriodSeconds": 10},
        "SupportedIdentityProviders": ["COGNITO"],
    }},
    "Api": {"Type": "AWS::ApiGatewayV2::Api", "Properties": {"Name": sub("yalla-${Environment}-bundle1"), "ProtocolType": "HTTP"}},
    "JwtAuthorizer": {"Type": "AWS::ApiGatewayV2::Authorizer", "Properties": {
        "ApiId": ref("Api"), "Name": "CognitoAccessToken", "AuthorizerType": "JWT", "IdentitySource": ["$request.header.Authorization"],
        "JwtConfiguration": {"Audience": [ref("UserPoolClient")], "Issuer": sub("https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}")},
    }},
    "AccessLogs": {"Type": "AWS::Logs::LogGroup", "Properties": {"RetentionInDays": 30}},
    "Stage": {"Type": "AWS::ApiGatewayV2::Stage", "Properties": {
        "ApiId": ref("Api"), "StageName": "$default", "AutoDeploy": True,
        "DefaultRouteSettings": {"ThrottlingBurstLimit": 20, "ThrottlingRateLimit": 10},
        "AccessLogSettings": {"DestinationArn": arn("AccessLogs"), "Format": '{"requestId":"$context.requestId","route":"$context.routeKey","status":"$context.status"}'},
    }},
}
resources["IncomingLogs"] = {"Type":"AWS::Logs::LogGroup", "Properties":{"LogGroupName":sub("/aws/lambda/yalla-${Environment}-incoming-raid"),"RetentionInDays":30}}
resources["IncomingRole"] = {"Type":"AWS::IAM::Role", "Properties":{
    "AssumeRolePolicyDocument":{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]},
    "Policies":[{"PolicyName":"IncomingRaid","PolicyDocument":{"Version":"2012-10-17","Statement":[
        {"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":sub("${IncomingLogs.Arn}:*")},
        {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:ConditionCheckItem"],"Resource":arn("PlayerTable")},
        {"Effect":"Allow","Action":["dynamodb:Query"],"Resource":[sub("${PlayerTable.Arn}/index/" + name) for name in ("IncomingDue", "PlayerActivity")]},
        {"Effect":"Allow","Action":["s3:GetObject"],"Resource":sub("arn:aws:s3:::yalla-result-pools-533266967583/game-config/${Environment}/v1/bots.json")}
    ]}}]}}
resources["IncomingFunction"] = {"Type":"AWS::Lambda::Function","DependsOn":"IncomingLogs","Properties":{
    "FunctionName":sub("yalla-${Environment}-incoming-raid"),"Runtime":"nodejs24.x","Architectures":["arm64"],
    "Handler":"dist/incoming-raid.handler","MemorySize":256,"Timeout":300,"Role":arn("IncomingRole"),
    "Code":{"S3Bucket":ref("ArtifactBucket"),"S3Key":ref("ArtifactKey")},
    "Environment":{"Variables":{"PLAYER_TABLE":ref("PlayerTable"),"GAME_CONFIG_BUCKET":"yalla-result-pools-533266967583","ENVIRONMENT":ref("Environment")}}}}
resources["IncomingRule"] = {"Type":"AWS::Events::Rule","Properties":{"ScheduleExpression":{"Fn::If":["IsDev",dev_schedule,"rate(5 minutes)"]},"State":"ENABLED","Targets":[{"Id":"incoming-raid","Arn":arn("IncomingFunction")}]}}
resources["IncomingPermission"] = {"Type":"AWS::Lambda::Permission","Properties":{"FunctionName":ref("IncomingFunction"),"Action":"lambda:InvokeFunction","Principal":"events.amazonaws.com","SourceArn":arn("IncomingRule")}}
for prefix in ["Auth", "Player"]:
    statements = [
        {"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"], "Resource": sub("${" + prefix + "Logs.Arn}:*")},
        {"Effect": "Allow", "Action": ["dynamodb:GetItem"], "Resource": arn("PlayerTable")},
        {"Effect": "Allow", "Action": ["dynamodb:PutItem"], "Resource": arn("PlayerTable"),
         "Condition": {"ForAllValues:StringEquals": {"dynamodb:EnclosingOperation": ["TransactWriteItems"]}}},
    ]
    if prefix == "Player":
        statements += [
            {"Effect": "Allow", "Action": ["dynamodb:Query"], "Resource": [arn("PlayerTable"), sub("${PlayerTable.Arn}/index/JourneyRead")]},
            {"Effect": "Allow", "Action": ["dynamodb:PutItem"], "Resource": arn("PlayerTable"),
             "Condition": {"ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["PLAYER#*"]},
                           "ForAllValues:StringEquals": {"dynamodb:Attributes": ["PK", "SK", "activityPartition", "lastActiveAt"]}}},
            {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::yalla-result-pools-533266967583",
             "Condition": {"StringLike": {"s3:prefix": "result-pools/v1/*"}}},
            {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::yalla-result-pools-533266967583/result-pools/v1/*",
              sub("arn:aws:s3:::yalla-result-pools-533266967583/game-config/${Environment}/v1/*")]}]
    if prefix == "Auth":
        statements.append({"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": [
            sub("arn:aws:s3:::yalla-result-pools-533266967583/game-config/${Environment}/v1/" + name + ".json")
            for name in ("raid", "bots")]})
        statements.append({"Effect": "Allow", "Action": ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser",
                           "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminInitiateAuth"], "Resource": arn("UserPool")})
    resources[prefix + "Role"] = {"Type": "AWS::IAM::Role", "Properties": {
        "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]},
        "Policies": [{"PolicyName": "Bundle1", "PolicyDocument": {"Version": "2012-10-17", "Statement": statements}}],
    }}
    resources[prefix + "Logs"] = {"Type": "AWS::Logs::LogGroup", "Properties": {
        "LogGroupName": sub("/aws/lambda/yalla-${Environment}-" + prefix.lower()), "RetentionInDays": 30}}
    resources[prefix + "Function"] = {"Type": "AWS::Lambda::Function", "DependsOn": prefix + "Logs", "Properties": {
        "FunctionName": sub("yalla-${Environment}-" + prefix.lower()), "Runtime": "nodejs24.x", "Architectures": ["arm64"],
        "Handler": "dist/handler.handler", "MemorySize": 256, "Timeout": 20, "Role": arn(prefix + "Role"),
        "Code": {"S3Bucket": ref("ArtifactBucket"), "S3Key": ref("ArtifactKey")},
        "Environment": {"Variables": {"PLAYER_TABLE": ref("PlayerTable"), "USER_POOL_ID": ref("UserPool"),
            "USER_POOL_CLIENT_ID": ref("UserPoolClient"), "ENVIRONMENT": ref("Environment"), "RANKING_PERIOD_DAYS": ref("RankingPeriodDays"), "RESULT_POLICY": "PERMISSIVE",
            "GAME_CONFIG_BUCKET": "yalla-result-pools-533266967583", "RESULT_POOL_BUCKET": "yalla-result-pools-533266967583", "RESULT_POOL_PREFIX": "result-pools/v1/",
            "PHYSICS_VERSION": "fixed-fresh-round-v1", "COGNITO_ISSUER": sub("https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}")}},
    }}
    resources[prefix + "Integration"] = {"Type": "AWS::ApiGatewayV2::Integration", "Properties": {
        "ApiId": ref("Api"), "IntegrationType": "AWS_PROXY", "IntegrationUri": arn(prefix + "Function"), "PayloadFormatVersion": "2.0"}}
    resources[prefix + "Permission"] = {"Type": "AWS::Lambda::Permission", "Properties": {
        "FunctionName": ref(prefix + "Function"), "Action": "lambda:InvokeFunction", "Principal": "apigateway.amazonaws.com",
        "SourceAccount": ref("AWS::AccountId"), "SourceArn": sub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*")}}
routes = [("AuthGuest", "POST /auth/guest", "Auth"), ("AuthRefresh", "POST /auth/refresh", "Auth"), ("AuthLogout", "POST /auth/logout", "Auth"),
          ("GuestCreate", "POST /players/guest", "Player"),
           ("PlayerHeartbeat", "POST /players/me/heartbeat", "Player"), ("ProfileGet", "GET /players/me", "Player"),
          ("SaveGet", "GET /players/me/save", "Player"), ("ProgressGet", "GET /players/me/progress", "Player"), ("WalletGet", "GET /players/me/wallet", "Player")]
routes += [("DropSessionOpen", "POST /drop/sessions", "Player"),
           ("DropSessionActive", "GET /drop/sessions/active", "Player"),
           ("DropRoundBegin", "POST /drop/sessions/{sessionId}/rounds", "Player"),
           ("DropRoundGet", "GET /drop/sessions/{sessionId}/rounds/{roundId}", "Player"),
           ("DropRoundResult", "POST /drop/sessions/{sessionId}/rounds/{roundId}/result", "Player"),
           ("DropRoundCancel", "POST /drop/sessions/{sessionId}/rounds/{roundId}/cancel", "Player")]
routes += [("DistanceRanking", "GET /ranking/distance", "Player"), ("PlayerActivityFeed", "GET /players/me/activity", "Player")]
routes += [("BonusGet", "GET /bonuses", "Player"), ("BonusEnsure", "POST /bonuses/ensure", "Player"),
           ("BonusAnnounce", "POST /bonuses/announce", "Player"), ("BonusFinish", "POST /bonuses/finish", "Player"),
           ("JackpotSpin", "POST /bonuses/jackpot/spins", "Player"), ("JackpotAck", "POST /bonuses/jackpot/{operationId}/ack", "Player"),
           ("RaidBegin", "POST /bonuses/raids", "Player"), ("RaidAttack", "POST /bonuses/raids/{operationId}/attack", "Player"),
           ("RaidPick", "POST /bonuses/raids/{operationId}/pick", "Player"), ("CostumePurchase", "POST /bonuses/costumes/purchase", "Player"),
           ("CostumeEquip", "POST /bonuses/costumes/equip", "Player"),
           ("RaidAck", "POST /bonuses/raids/{operationId}/ack", "Player"), ("RaidCancel", "POST /bonuses/raids/{operationId}/cancel", "Player")]
routes += [("WorldState", "GET /worlds/state", "Player"), ("WorldUpgrade", "POST /worlds/upgrade", "Player"),
           ("WorldRepair", "POST /worlds/repair", "Player"),
           ("WorldComplete", "POST /worlds/complete", "Player"), ("WorldSelect", "POST /worlds/select", "Player")]
for name, route, prefix in routes:
    properties = {"ApiId": ref("Api"), "RouteKey": route, "Target": {"Fn::Join": ["/", ["integrations", ref(prefix + "Integration")]]}, "AuthorizationType": "NONE"}
    if prefix == "Player":
        properties.update({"AuthorizationType": "JWT", "AuthorizerId": ref("JwtAuthorizer"), "AuthorizationScopes": ["aws.cognito.signin.user.admin"]})
    resources[name + "Route"] = {"Type": "AWS::ApiGatewayV2::Route", "Properties": properties}
# Friends share the PlayerTable and are exposed through the DEV API.
for name, route in (
    ("Code", "GET /friends/code"), ("Search", "GET /friends/search"),
    ("Incoming", "GET /friends/requests/incoming"), ("Outgoing", "GET /friends/requests/outgoing"),
    ("List", "GET /friends/list"), ("Count", "GET /friends/count"),
    ("Suggested", "GET /friends/suggested"), ("Rank", "GET /friends/rank"),
    ("Request", "POST /friends/requests"), ("Action", "POST /friends/actions"),
    ("Invite", "GET /invites/{code}"),
):
    properties = {"ApiId": ref("Api"), "RouteKey": route, "Target": sub("integrations/${PlayerIntegration}"), "AuthorizationType": "NONE"}
    if name != "Invite":
        properties.update({"AuthorizationType": "JWT", "AuthorizerId": ref("JwtAuthorizer"),
                           "AuthorizationScopes": ["aws.cognito.signin.user.admin"]})
    resources["Friends" + name + "Route"] = {"Type": "AWS::ApiGatewayV2::Route", "Condition": "IsDev", "Properties": properties}
resources["PlayerRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"].append({
    "Effect": "Allow", "Action": "dynamodb:DeleteItem", "Resource": arn("PlayerTable"),
    "Condition": {"ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["PLAYER#*"]},
                  "StringEquals": {"dynamodb:EnclosingOperation": "TransactWriteItems"}},
})
resources["PlayerFunction"]["Properties"]["Environment"]["Variables"]["FRIENDS_BOT_AUTO_ACCEPT"] = {
    "Fn::If": ["IsDev", "true", "false"]}
parameters["NotificationArtifactKey"] = {"Type": "String", "Default": ""}
notification_artifact = {"Fn::If": ["HasNotificationArtifact", ref("NotificationArtifactKey"), ref("ArtifactKey")]}
resources["PlayerFunction"]["Properties"]["Code"]["S3Key"] = notification_artifact
resources["PlayerFunction"]["Properties"]["Environment"]["Variables"]["RANKING_PERIOD_DAYS"] = {
    "Fn::If": ["HasNotificationArtifact", "7", ref("RankingPeriodDays")]}
# DEV notification settings are embedded in the function configuration at deployment.
notification_config = json.dumps(json.loads((root.parent / "config/dev/notifications.json").read_text()), separators=(",", ":"))
for suffix, route in (("Register", "POST /players/me/devices"), ("Delete", "DELETE /players/me/devices/{deviceId}")):
    resources["NotificationDevice" + suffix] = {"Type": "AWS::ApiGatewayV2::Route", "Condition": "IsDev",
        "Properties": {"ApiId": ref("Api"), "RouteKey": route, "AuthorizationType": "JWT", "AuthorizerId": ref("JwtAuthorizer"),
        "AuthorizationScopes": ["aws.cognito.signin.user.admin"],
        "Target": {"Fn::Join": ["/", ["integrations", ref("PlayerIntegration")]]}}}

def notification_resource(name, kind, props):
    resources[name] = {"Type": kind, "Condition": "IsDev", "Properties": props}

notification_resource("NotificationDeliveryTable", "AWS::DynamoDB::Table", {
    "BillingMode":"PAY_PER_REQUEST","AttributeDefinitions":[{"AttributeName":key,"AttributeType":"S"} for key in ("PK","SK")],
    "KeySchema":[{"AttributeName":"PK","KeyType":"HASH"},{"AttributeName":"SK","KeyType":"RANGE"}],
    "TimeToLiveSpecification":{"AttributeName":"notificationExpiresAt","Enabled":True}})
notification_resource("NotificationDLQ", "AWS::SQS::Queue", {"QueueName": "yalla-dev-notification-push-dlq",
    "MessageRetentionPeriod": 1209600, "SqsManagedSseEnabled": True})
notification_resource("NotificationQueue", "AWS::SQS::Queue", {"QueueName": "yalla-dev-notification-push",
    "MessageRetentionPeriod": 345600, "VisibilityTimeout": 360, "SqsManagedSseEnabled": True,
    "RedrivePolicy": {"deadLetterTargetArn": arn("NotificationDLQ"), "maxReceiveCount": 5}})
notification_resource("NotificationDevicePolicy", "AWS::IAM::Policy", {"PolicyName": "NotificationDevices",
    "Roles": [ref("PlayerRole")], "PolicyDocument": {"Version": "2012-10-17", "Statement": [{
      "Effect": "Allow", "Action": ["dynamodb:PutItem", "dynamodb:DeleteItem"], "Resource": arn("PlayerTable"),
      "Condition": {"ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["PLAYER#*", "SYSTEM#PUSH_TOKEN", "SYSTEM#PUSH_INSTALLATION"]},
                    "StringEquals": {"dynamodb:EnclosingOperation": "TransactWriteItems"}}
    }]}})
for kind, handler, statements, env in [
    ("Router", "notification-router", [
      {"Effect":"Allow","Action":["dynamodb:DescribeStream","dynamodb:GetRecords","dynamodb:GetShardIterator","dynamodb:ListStreams"],
       "Resource":{"Fn::GetAtt":["PlayerTable","StreamArn"]}},
      {"Effect":"Allow","Action":["sqs:SendMessage"],"Resource":arn("NotificationQueue")},
      {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:Query"],"Resource":arn("PlayerTable"),
       "Condition":{"ForAllValues:StringLike":{"dynamodb:LeadingKeys":["PLAYER#*"]}}},
      {"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::yalla-result-pools-533266967583/game-config/dev/v1/world-buildings.json"},
    ], {"PUSH_QUEUE_URL":ref("NotificationQueue"),"GAME_CONFIG_BUCKET":"yalla-result-pools-533266967583",
        "ENVIRONMENT":"dev","PLAYER_TABLE":ref("PlayerTable"),
        "RANKING_PERIOD_DAYS":resources["PlayerFunction"]["Properties"]["Environment"]["Variables"]["RANKING_PERIOD_DAYS"]}),
    ("Worker", "notification-worker", [
      {"Effect":"Allow","Action":["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes"],"Resource":arn("NotificationQueue")},
      {"Effect":"Allow","Action":["dynamodb:Query","dynamodb:GetItem","dynamodb:UpdateItem"],"Resource":arn("PlayerTable"),
       "Condition":{"ForAllValues:StringLike":{"dynamodb:LeadingKeys":["PLAYER#*"]}}},
      {"Effect":"Allow","Action":"dynamodb:GetItem","Resource":arn("PlayerTable"),
       "Condition":{"ForAllValues:StringEquals":{"dynamodb:LeadingKeys":["SYSTEM#PUSH_INSTALLATION"]}}},
      {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem"],"Resource":arn("NotificationDeliveryTable")},
      {"Effect":"Allow","Action":["ssm:GetParameter"],"Resource":sub("arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/yalla/dev/notifications/apns-private-key")},
    ], {"APNS_PARAMETER":"/yalla/dev/notifications/apns-private-key","PLAYER_TABLE":ref("PlayerTable"),"PUSH_DELIVERY_TABLE":ref("NotificationDeliveryTable")}),
]:
    prefix = "Notification" + kind
    name = "yalla-dev-notification-" + kind.lower()
    notification_resource(prefix+"Logs","AWS::Logs::LogGroup",{"LogGroupName":"/aws/lambda/"+name,"RetentionInDays":30})
    notification_resource(prefix+"Role","AWS::IAM::Role",{
      "AssumeRolePolicyDocument":{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]},
      "Policies":[{"PolicyName":"Notification"+kind,"PolicyDocument":{"Version":"2012-10-17","Statement":statements+[
        {"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],
         "Resource":sub("${"+prefix+"Logs.Arn}:*")} ]}}]})
    notification_resource(prefix+"Function","AWS::Lambda::Function",{
      "FunctionName":name,"Handler":"dist/"+handler+".handler","Runtime":"nodejs24.x","Architectures":["arm64"],
      "Timeout":60,"MemorySize":256,"Role":arn(prefix+"Role"),"Code":{"S3Bucket":ref("ArtifactBucket"),"S3Key":notification_artifact},
      "Environment":{"Variables":{"NOTIFICATION_CONFIG":notification_config,**env}}})
notification_resource("NotificationStreamMapping","AWS::Lambda::EventSourceMapping",{
    "FunctionName":ref("NotificationRouterFunction"),"EventSourceArn":{"Fn::GetAtt":["PlayerTable","StreamArn"]},
    "StartingPosition":"LATEST","BatchSize":5,"MaximumRetryAttempts":5,"BisectBatchOnFunctionError":True,
    "FunctionResponseTypes":["ReportBatchItemFailures"],"DestinationConfig":{"OnFailure":{"Destination":arn("NotificationDLQ")}},
    "FilterCriteria":{"Filters":[
      {"Pattern":json.dumps({"dynamodb":{"Keys":{"SK":{"S":[
         {"prefix":"INCOMING#RECEIPT#"},{"prefix":"INCOMING#WALLET_RAID#"}]}}}},separators=(",",":"))},
      {"Pattern":json.dumps({"eventName":["MODIFY"],"dynamodb":{"Keys":{"SK":{"S":[{"prefix":"ROUND#"}]}},
        "NewImage":{"status":{"S":["SETTLED"]},"rankDistance":{"S":[{"exists":True}]}}}},separators=(",",":"))},
    ]}})
resources["NotificationRouterRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"].append(
    {"Effect":"Allow","Action":"sqs:SendMessage","Resource":arn("NotificationDLQ")})
notification_resource("NotificationQueueMapping","AWS::Lambda::EventSourceMapping",{
    "FunctionName":ref("NotificationWorkerFunction"),"EventSourceArn":arn("NotificationQueue"),
    "BatchSize":5,"FunctionResponseTypes":["ReportBatchItemFailures"]})

template = {"AWSTemplateFormatVersion": "2010-09-09", "Parameters": parameters,
            "Conditions": {"IsDev": {"Fn::Equals": [ref("Environment"), "dev"]},
                "HasNotificationArtifact": {"Fn::And": [{"Condition":"IsDev"},
                  {"Fn::Not": [{"Fn::Equals":[ref("NotificationArtifactKey"), ""]}]}]}}, "Resources": resources,
            "Outputs": {key: {"Value": value} for key, value in {
                "ApiEndpoint": {"Fn::GetAtt": ["Api", "ApiEndpoint"]}, "ApiId": ref("Api"), "PlayerTable": ref("PlayerTable"),
                "UserPoolId": ref("UserPool"), "UserPoolClientId": ref("UserPoolClient"),
                "AuthFunction": ref("AuthFunction"), "PlayerFunction": ref("PlayerFunction")}.items()}}
for name, value in [("artifacts.json", storage), ("bundle1.json", template)]:
    (root / name).write_text(json.dumps(value, indent=2) + "\n")
